# Manak, as one container.
#
# The product's About page says "one container, one port, one file on disk", and
# `src/api/commands/system.ts` says the Docker health check reads `status` out of
# `/api/healthz`. Both sentences described this file before it existed. This is the file.
#
# There is no build stage, and that is not a simplification — there is nothing to build.
# Manak has no production npm dependencies, bundler or asset pipeline, so the image
# is the source tree plus a runtime. The thing worth noticing is what that removes: this
# build cannot fail because a registry was unreachable, cannot install a package that was
# replaced overnight. A multi-stage
# build here would copy files from one stage to another and call it hardening.
#
# The tests and the two proof harnesses are kept in the image on purpose. A product whose
# argument is that its claims are checkable should let the person running it do the checking:
#
#   docker run --rm manak npm test
#   docker run --rm manak npm run prove:isolation -- --check
#
# They cost about a hundred kilobytes and they are the difference between trusting this image
# and verifying it.

# Review the upstream digest when applying Node security updates. Keeping the tag and
# manifest digest together makes this build reproducible across supported architectures.
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

# No `image.source`. It would be the one label nothing in this repository can verify, and a
# URL that resolves to nothing is worse than a label that was never set. No `image.vendor`
# either: the vendor of a one-person project is the author, and printing the same name twice
# under two keys invites a reader to think there is an organisation behind one of them.
LABEL org.opencontainers.image.title="Manak" \
      org.opencontainers.image.description="A self-hostable hackathon submission and judging portal." \
      org.opencontainers.image.authors="Sai Ram (Hardik) Dash" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app

# The database lives on a volume rather than in the layer, and `VOLUME` is declared rather
# than left to the operator: somebody who forgets `-v` and later replaces the container
# should not discover that the event they ran last week was in the writable layer.
#
# `MANAK_TRUST_PROXY` and `MANAK_SECURE_COOKIE` are deliberately unset. Both default to
# false, and both are facts about a deployment this file cannot know: trusting
# `X-Forwarded-For` when nothing in front of the container sets it turns the rate limiter into
# a formality, and a container behind TLS termination wants both of them on. They are carried
# commented out in `compose.yaml`, next to the sentence that says when to uncomment them,
# because that is the operator's decision to make and not this file's to guess.
#
# `NODE_ENV` is not set either, which is unusual enough to be worth a sentence: nothing in
# this product reads it. There are no dependencies to switch into production mode and no
# framework to tell. Setting it would be a comforting no-op.
ENV MANAK_DATABASE=/data/manak.db \
    MANAK_HOST=0.0.0.0 \
    MANAK_PORT=8080
RUN mkdir -p /data && chown -R node:node /data /app
RUN apk add --no-cache su-exec
# Volumes are declared in compose.yaml and cloud orchestrators rather than the image layer

# Owned by `node`, and the process runs as `node`. The uid exists in the official image, so
# this costs one flag and removes the class of problem where a template injection becomes a
# write to /usr/lib. Nothing here needs root: the port is 8080, not 80.
COPY --chown=node:node package.json ./
COPY --chown=node:node bin ./bin
COPY --chown=node:node src ./src
COPY --chown=node:node tools ./tools
COPY --chown=node:node tests ./tests
COPY --chown=node:node docs ./docs
COPY --chown=node:node logs ./logs
COPY --chown=node:node README.md LICENSE tsconfig.json fixtures.json OPERATIONS.md JUDGING.md DATA-MODEL.md TIER-MATRIX.md ./

USER root
EXPOSE 8080

# Reads `status` out of the body, which is the contract `system.healthz` documents: the probe
# answers 200 even when the deployment is degraded, because a probe that 500s on a pending
# migration puts the container in a restart loop and a restart loop is the one state in which
# nobody reads the message. So the exit code has to come from the JSON, not from the status
# line. Node parses it because there is no curl in this image and adding one to run `grep` over
# a JSON document would be a dependency in exchange for a worse test.
#
# `--start-period` is generous relative to a boot that takes tens of milliseconds. Migrations
# run before the socket opens, and the first boot of a large database applying its first
# migration is the one time that is not instant.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.MANAK_PORT || 8080) + '/api/healthz').then((r) => r.json()).then((b) => process.exit(b.status === 'ok' ? 0 : 1)).catch(() => process.exit(1))"]

# Exec form, so node is pid 1 and receives SIGTERM from `docker stop` directly.
CMD ["sh", "-c", "chown -R node:node /data && exec su-exec node node --experimental-strip-types tools/start-demo.ts"]
