#!/usr/bin/env python3
"""Check live Manak T3/T4 behavior using only Python's standard library.

Usage (Python 3.11+):
    python3 tools/check_extended.py [.dogfood.toml] [--json] [--allow-incomplete]

The checker reads the portal URL, event route, and role cookies from the DogFood TOML
file. It does not log in or infer success from source claims. Each result includes the
HTTP evidence used. Checks that need an open voting window, issued certificates, or a
feature with no live API are reported BLOCKED/PARTIAL/UNSUPPORTED. It avoids operations
that would publish results, submit reviews, send webhooks, or otherwise alter judging.
If voting is currently open, it creates up to three empty voter sessions to check
per-session ballot stability and cross-session ordering; it casts no votes.

Exit status: 0 means all available checks verified; 1 means a check failed; 2 means the
run is incomplete because a prerequisite is unavailable or a feature is unsupported.
Use --allow-incomplete to accept an honest partial inventory as a successful run.
"""

from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import io
import json
import re
import sys
import time
import tomllib
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Callable


@dataclass
class Response:
    status: int | None
    headers: dict[str, str]
    body: bytes
    error: str | None = None

    def json(self) -> Any:
        return json.loads(self.body.decode("utf-8"))

    @property
    def text(self) -> str:
        return self.body.decode("utf-8", errors="replace")


@dataclass
class Result:
    name: str
    status: str
    detail: str
    evidence: dict[str, Any]


class Portal:
    def __init__(self, base_url: str, timeout: float):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def request(
        self,
        path: str,
        *,
        method: str = "GET",
        auth: str | None = None,
        payload: dict[str, Any] | None = None,
        user_agent: str = "Manak-Extended-Checker/1.0",
    ) -> Response:
        url = urllib.parse.urljoin(self.base_url + "/", path.lstrip("/"))
        headers = {"Accept": "application/json, text/csv, text/plain, */*", "User-Agent": user_agent}
        if auth:
            key, separator, value = auth.partition(":")
            if not separator:
                raise ValueError(f"invalid auth header in .dogfood.toml: {auth!r}")
            headers[key.strip()] = value.strip()
        data = None
        if payload is not None:
            data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return Response(response.status, {k.lower(): v for k, v in response.headers.items()}, response.read())
        except urllib.error.HTTPError as error:
            return Response(error.code, {k.lower(): v for k, v in error.headers.items()}, error.read(), str(error))
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            return Response(None, {}, b"", str(error))


def _decode_point(encoded: bytes) -> tuple[int, int] | None:
    q = 2**255 - 19
    d = (-121665 * pow(121666, q - 2, q)) % q
    sqrt_m1 = pow(2, (q - 1) // 4, q)
    if len(encoded) != 32:
        return None
    value = int.from_bytes(encoded, "little")
    sign = value >> 255
    y = value & ((1 << 255) - 1)
    if y >= q:
        return None
    y2 = y * y % q
    x2 = (y2 - 1) * pow((d * y2 + 1) % q, q - 2, q) % q
    x = pow(x2, (q + 3) // 8, q)
    if (x * x - x2) % q:
        x = x * sqrt_m1 % q
    if (x * x - x2) % q:
        return None
    if x == 0 and sign:
        return None
    if (x & 1) != sign:
        x = q - x
    return x, y


def _point_add(p: tuple[int, int], r: tuple[int, int]) -> tuple[int, int]:
    q = 2**255 - 19
    d = (-121665 * pow(121666, q - 2, q)) % q
    x1, y1 = p
    x2, y2 = r
    product = d * x1 * x2 * y1 * y2 % q
    x3 = (x1 * y2 + x2 * y1) * pow((1 + product) % q, q - 2, q) % q
    y3 = (y1 * y2 + x1 * x2) * pow((1 - product) % q, q - 2, q) % q
    return x3, y3


def _scalar_mult(scalar: int, point: tuple[int, int]) -> tuple[int, int]:
    result = (0, 1)
    addend = point
    while scalar:
        if scalar & 1:
            result = _point_add(result, addend)
        addend = _point_add(addend, addend)
        scalar >>= 1
    return result


def _encode_point(point: tuple[int, int]) -> bytes:
    x, y = point
    return (y | ((x & 1) << 255)).to_bytes(32, "little")


def ed25519_verify(public_key: bytes, message: bytes, signature: bytes) -> bool:
    """Verify Ed25519 using RFC 8032 arithmetic; no third-party modules required."""
    q = 2**255 - 19
    order = 2**252 + 27742317777372353535851937790883648493
    if len(public_key) != 32 or len(signature) != 64:
        return False
    r_encoded, scalar_encoded = signature[:32], signature[32:]
    scalar = int.from_bytes(scalar_encoded, "little")
    if scalar >= order:
        return False
    public_point = _decode_point(public_key)
    r_point = _decode_point(r_encoded)
    if public_point is None or r_point is None:
        return False
    identity = (0, 1)
    if _scalar_mult(order, public_point) != identity or _scalar_mult(order, r_point) != identity:
        return False
    if public_point == identity:
        return False
    base_y = 4 * pow(5, q - 2, q) % q
    base_encoded_value = base_y
    base = _decode_point(base_encoded_value.to_bytes(32, "little"))
    if base is None:
        return False
    challenge = int.from_bytes(hashlib.sha512(r_encoded + public_key + message).digest(), "little") % order
    left = _scalar_mult(scalar, base)
    right = _point_add(r_point, _scalar_mult(challenge, public_point))
    return _encode_point(left) == _encode_point(right)


def certificate_digest(certificate: dict[str, Any]) -> bytes:
    fields: list[Any] = [
        certificate["serial"], certificate["eventId"], certificate["eventName"],
        certificate["recipientName"], certificate["recipientEmail"], certificate["category"],
        certificate["detail"], certificate["issuedAt"], certificate["issuerOrigin"],
    ]
    version = certificate.get("certificateVersion")
    if version == 2:
        fields.extend([2, certificate.get("issuerKeyId"), certificate.get("publicationRevision"), certificate.get("publicationDigest")])
    elif version == 3:
        presentation = certificate.get("presentation") or {}
        fields.extend([
            3, certificate.get("issuerKeyId"), certificate.get("publicationRevision"),
            certificate.get("publicationDigest"), presentation.get("heading"),
            presentation.get("body"), presentation.get("footer"),
            presentation.get("signatory"), presentation.get("logoSha256"),
        ])
    canonical = json.dumps(fields, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(canonical.encode("utf-8")).digest()


def raw_ed25519_public_key(pem: str) -> bytes:
    der = base64.b64decode("".join(line for line in pem.splitlines() if not line.startswith("-----")), validate=True)
    prefix = bytes.fromhex("302a300506032b6570032100")
    if len(der) != len(prefix) + 32 or not der.startswith(prefix):
        raise ValueError("certificate key is not an Ed25519 SubjectPublicKeyInfo PEM")
    return der[-32:]


def check_config(path: Path) -> tuple[dict[str, Any], str, str]:
    with path.open("rb") as handle:
        config = tomllib.load(handle)
    base_url = str(config["portal"]["base_url"])
    gallery = str(config["routes"]["gallery"])
    match = re.fullmatch(r"/api/events/([^/]+)/projects/?", gallery)
    if not match:
        raise ValueError("routes.gallery must have the form /api/events/<event>/projects")
    event_id = urllib.parse.unquote(match.group(1))
    auth = config.get("auth", {})
    missing = [role for role in ("organizer", "judge_a", "judge_b", "participant") if not auth.get(role)]
    if missing:
        raise ValueError("missing .dogfood.toml auth entries: " + ", ".join(missing))
    if not base_url.startswith(("http://", "https://")):
        raise ValueError("portal.base_url must use http:// or https://")
    return config, event_id, base_url


class Checker:
    def __init__(self, config: dict[str, Any], event_id: str, portal: Portal):
        self.config = config
        self.event_id = event_id
        self.portal = portal
        self.auth = config["auth"]
        self.results: list[Result] = []
        self.prefix = f"/api/events/{urllib.parse.quote(event_id, safe='')}"
        self.operations: set[tuple[str, str]] = set()
        self.operation_details: list[dict[str, Any]] = []

    def record(self, name: str, status: str, detail: str, **evidence: Any) -> None:
        self.results.append(Result(name, status, detail, evidence))

    def api(self, path: str, **kwargs: Any) -> Response:
        return self.portal.request(path, **kwargs)

    def docs(self) -> Response:
        return self.api("/api/docs")

    def check_health_and_api(self) -> None:
        health = self.api("/api/healthz")
        if health.status != 200:
            self.record("HTTP health and ledger head", "FAILED" if health.status else "BLOCKED",
                        "health endpoint did not return HTTP 200", http_status=health.status, error=health.error)
        else:
            try:
                body = health.json()
                ledger = body.get("ledger", {})
                ok = body.get("status") == "ok" and isinstance(ledger.get("length"), int) and re.fullmatch(r"[0-9a-f]{64}", str(ledger.get("headHash", ""))) is not None
                self.record("HTTP health and ledger head", "VERIFIED" if ok else "FAILED",
                            "health status and advertised ledger head inspected; this does not verify the full chain",
                            service_status=body.get("status"), ledger_length=ledger.get("length"), head_hash=ledger.get("headHash"))
            except (ValueError, AttributeError) as error:
                self.record("HTTP health and ledger head", "FAILED", "health response was not the expected JSON", error=str(error))

        doc_response = self.docs()
        if doc_response.status != 200:
            self.record("Live API operation catalog", "FAILED" if doc_response.status else "BLOCKED",
                        "GET /api/docs did not return HTTP 200", http_status=doc_response.status, error=doc_response.error)
            return
        try:
            items = doc_response.json().get("operations", [])
            self.operation_details = items
            self.operations = {(str(item.get("method", "GET")), str(item.get("path", ""))) for item in items}
            self.record("Live API operation catalog", "VERIFIED" if len(self.operations) > 0 else "FAILED",
                        "operation catalog was fetched from the running server", operation_count=len(self.operations))
        except (ValueError, AttributeError) as error:
            self.record("Live API operation catalog", "FAILED", "operation catalog was not valid JSON", error=str(error))

        openapi = self.api("/api/openapi.json")
        if openapi.status == 200:
            try:
                spec = openapi.json()
                version = spec.get("openapi")
                paths = spec.get("paths", {})
                ok = str(version).startswith("3.") and len(paths) > 0
                self.record("OpenAPI document", "VERIFIED" if ok else "FAILED",
                            "live OpenAPI document and path inventory inspected", version=version, path_count=len(paths))
            except (ValueError, AttributeError) as error:
                self.record("OpenAPI document", "FAILED", "OpenAPI response was not valid JSON", error=str(error))
        else:
            self.record("OpenAPI document", "FAILED" if openapi.status else "BLOCKED",
                        "GET /api/openapi.json did not return HTTP 200", http_status=openapi.status, error=openapi.error)

    def check_gallery_and_t3(self) -> dict[str, Any] | None:
        gallery_path = self.config["routes"]["gallery"]
        gallery = self.api(gallery_path)
        projects: list[dict[str, Any]] = []
        if gallery.status != 200:
            self.record("Public project gallery", "FAILED" if gallery.status else "BLOCKED",
                        "anonymous gallery request did not return HTTP 200", http_status=gallery.status, error=gallery.error)
        else:
            try:
                body = gallery.json()
                projects = body.get("projects", [])
                submitted = [project for project in projects if project.get("status") == "submitted"]
                ok = body.get("visibility") == "public" and bool(submitted)
                self.record("Public project gallery", "VERIFIED" if ok else "FAILED",
                            "anonymous gallery exposes submitted work and declares public visibility",
                            visibility=body.get("visibility"), project_count=len(projects), submitted_count=len(submitted))
            except (ValueError, AttributeError) as error:
                self.record("Public project gallery", "FAILED", "gallery response was not the expected JSON", error=str(error))

        # A valid-shaped POST against a deliberately nonexistent project tests the
        # account gate without risking an accidental comment on a real submission.
        comment_path = self.prefix + "/projects/extended-check-nonexistent/comments"
        comment = self.api(comment_path, method="POST", payload={"body": "extended-check authentication probe"})
        if comment.status in (401, 403):
            self.record("Anonymous comment authorization", "VERIFIED",
                        "comment write was rejected before project lookup", http_status=comment.status)
        else:
            self.record("Anonymous comment authorization", "FAILED" if comment.status else "BLOCKED",
                        "expected an authentication/authorization refusal (401 or 403) on the comment write",
                        http_status=comment.status, error=comment.error, response=comment.text[:240])

        # Result privacy is meaningful only if the live event is currently voting.
        event_res = self.api(self.prefix, auth=self.auth["organizer"])
        active_voting = False
        event: dict[str, Any] | None = None
        if event_res.status == 200:
            try:
                event = event_res.json().get("event", {})
                now_ms = int(time.time() * 1000)
                opens, closes = event.get("votingOpenAt"), event.get("votingCloseAt")
                active_voting = event.get("votingMode") != "off" and isinstance(opens, int) and isinstance(closes, int) and opens <= now_ms < closes
                if active_voting:
                    results = self.api(self.prefix + "/results")
                    passed = results.status in (401, 403, 404, 409)
                    self.record("Results hidden during active voting", "VERIFIED" if passed else "FAILED",
                                "public results are refused while the event reports an open voting window",
                                voting_mode=event.get("votingMode"), http_status=results.status)
                else:
                    self.record("Results hidden during active voting", "BLOCKED",
                                "the configured event has no active voting window, so the privacy gate cannot be observed",
                                voting_mode=event.get("votingMode"), voting_open_at=opens, voting_close_at=closes)
            except (ValueError, AttributeError) as error:
                self.record("Results hidden during active voting", "BLOCKED", "event timing data could not be inspected", error=str(error))
        else:
            self.record("Results hidden during active voting", "BLOCKED", "could not read event timing preconditions",
                        http_status=event_res.status, error=event_res.error)

        if not active_voting:
            self.record("Per-voter ballot shuffle", "BLOCKED", "requires an event whose voting mode and voting window are currently active")
        else:
            self._check_ballot_shuffle()

        self._catalog_gap("Duplicate project quarantine and organizer triage",
                          lambda path: "duplicate" in path or "quarantine" in path,
                          "no duplicate/quarantine operation is exposed by the live API catalog; advisory title warnings do not quarantine")
        self.record("Full hash-chain verification over HTTP", "PARTIAL",
                    "the health endpoint publishes only chain length and head hash; no live endpoint returns the complete prev-hash sequence")
        self.record("Rate-limit flood refusal", "UNSUPPORTED",
                    "not probed: exercising a live 429 threshold can throttle legitimate evaluators; no safe read-only proof endpoint is exposed")
        return event if isinstance(event, dict) else None

    def _check_ballot_shuffle(self) -> None:
        paths: list[list[str]] = []
        failures: list[str] = []
        hard_failure = False
        for n in range(3):
            created = self.api(self.prefix + "/votes/start", method="POST", payload={}, user_agent=f"Manak-Extended-Checker/1.0 voter-{n}-{time.time_ns()}")
            if created.status != 200:
                failures.append(f"session {n + 1}: HTTP {created.status}")
                hard_failure = hard_failure or created.status is not None
                continue
            try:
                token = created.json().get("token")
                if not isinstance(token, str) or len(token) != 43:
                    failures.append(f"session {n + 1}: response omitted a 43-character token")
                    hard_failure = True
                    continue
                cookie = f"manak_voter_{self.event_id}={token}"
                ballot = self.api(self.prefix + "/voting", auth=f"Cookie: {cookie}")
                if ballot.status != 200:
                    failures.append(f"session {n + 1}: ballot HTTP {ballot.status}")
                    hard_failure = hard_failure or ballot.status is not None
                    continue
                projects = ballot.json().get("projects", [])
                paths.append([str(project.get("id")) for project in projects])
                repeated = self.api(self.prefix + "/voting", auth=f"Cookie: {cookie}")
                if repeated.status != 200:
                    failures.append(f"session {n + 1}: repeated ballot HTTP {repeated.status}")
                    hard_failure = hard_failure or repeated.status is not None
                else:
                    repeated_order = [str(project.get("id")) for project in repeated.json().get("projects", [])]
                    if repeated_order != paths[-1]:
                        failures.append(f"session {n + 1}: order changed within one voter session")
                        hard_failure = True
            except (ValueError, AttributeError) as error:
                failures.append(f"session {n + 1}: malformed response ({error})")
                hard_failure = True
        if failures:
            self.record("Per-voter ballot shuffle", "FAILED" if hard_failure else "BLOCKED",
                        "live ballot session or stability check did not meet its expected HTTP outcome",
                        failures=failures)
        elif len(paths) < 2:
            self.record("Per-voter ballot shuffle", "FAILED", "fewer than two independent ballots could be created", session_count=len(paths))
        elif any(order != paths[0] for order in paths[1:]):
            self.record("Per-voter ballot shuffle", "VERIFIED",
                        "repeated requests stayed stable per session and independent voter sessions received different project orders",
                        orders=paths)
        else:
            self.record("Per-voter ballot shuffle", "BLOCKED", "all sampled voters happened to receive the same order; cross-voter shuffle could not be distinguished", orders=paths)

    def check_t4(self) -> None:
        for kind in ("registrations", "teams", "projects", "scores", "results", "audit"):
            path = f"{self.prefix}/export/{kind}.csv"
            response = self.api(path, auth=self.auth["organizer"])
            content_type = response.headers.get("content-type", "")
            disposition = response.headers.get("content-disposition", "")
            valid_csv = False
            header: list[str] = []
            if response.status == 200 and "text/csv" in content_type:
                try:
                    header = next(csv.reader(io.StringIO(response.text)))
                    valid_csv = bool(header)
                except (csv.Error, StopIteration):
                    pass
            passed = response.status == 200 and valid_csv and "attachment" in disposition.lower()
            self.record(f"CSV export: {kind}", "VERIFIED" if passed else ("FAILED" if response.status else "BLOCKED"),
                        "download status, CSV content type, attachment name, and header inspected",
                        http_status=response.status, content_type=content_type, disposition=disposition, header=header[:12], error=response.error)

        self._check_certificates()
        widget = self.api("/widget.js")
        if widget.status == 200 and "javascript" in widget.headers.get("content-type", "") and "/api/events/" in widget.text and "data-manak-gallery" in widget.text:
            self.record("Embeddable gallery widget", "PARTIAL",
                        "live widget script loads and queries public projects; it is a JS-rendered widget, not the planned resizing iframe/postMessage embed",
                        http_status=widget.status, content_type=widget.headers.get("content-type"), bytes=len(widget.body))
        else:
            self.record("Embeddable gallery widget", "FAILED" if widget.status else "BLOCKED",
                        "widget route did not expose the expected live gallery loader", http_status=widget.status,
                        content_type=widget.headers.get("content-type"), error=widget.error)

        webhook_path = self.prefix + "/webhooks"
        webhook = self.api(webhook_path, auth=self.auth["organizer"])
        if webhook.status == 200:
            try:
                body = webhook.json()
                supported = body.get("signatureAlgorithm") == "HMAC-SHA256" and "X-Manak-Signature" == body.get("headerSignature")
                self.record("Webhook signing contract", "VERIFIED" if supported else "FAILED",
                            "live endpoint publishes the HMAC signature contract; this does not prove delivery",
                            http_status=webhook.status, algorithm=body.get("signatureAlgorithm"), actions=body.get("supportedActions"))
            except (ValueError, AttributeError) as error:
                self.record("Webhook signing contract", "FAILED", "webhook contract response was not valid JSON", error=str(error))
        else:
            self.record("Webhook signing contract", "FAILED" if webhook.status else "BLOCKED",
                        "organizer webhook contract request did not return HTTP 200", http_status=webhook.status, error=webhook.error)
        self._catalog_gap("Webhook delivery lifecycle",
                          lambda path: "webhook" in path and "/ping" not in path,
                          "live API catalog exposes no webhook subscription or delivery lifecycle")
        self.record("Transactional webhook outbox and SSRF DNS pinning", "BLOCKED",
                    "storage transactionality and socket-level destination pinning are not observable through read-only HTTP checks")
        self._catalog_gap("Archive export/import roundtrip", lambda path: "archive" in path or "import" in path,
                          "no live HTTP archive/import operation is exposed; the documented archive workflow is CLI-based")
        self._catalog_gap("Scoped API token console", lambda path: "/me/tokens" in path or "api-token" in path,
                          "no scoped token management operation is exposed by the live API catalog")
        self._catalog_gap("Anti-abuse address canonicalization and voter voiding",
                          lambda path: "voter" in path and ("void" in path or "email" in path),
                          "the live API catalog exposes no explicit voter-void or email-canonicalization management operation")
        self._catalog_gap("Team leave and invitation rotation",
                          lambda path: "team" in path and ("leave" in path or "invite" in path and ("rotate" in path or "reset" in path)),
                          "the live API catalog exposes no participant leave or invite-rotation operation")
        recusal_ops = [operation for operation in self.operation_details
                       if "recusal" in str(operation.get("path", "")).lower()]
        self_route = any("judge" in str(operation.get("callableBy", "")).lower()
                         and "organizer" not in str(operation.get("callableBy", "")).lower()
                         for operation in recusal_ops)
        if self_route:
            self.record("Judge self-recusal capacity top-up", "BLOCKED",
                        "a judge-callable recusal operation exists, but safe replacement-capacity behavior needs a controlled judge assignment")
        elif recusal_ops:
            self.record("Judge self-recusal capacity top-up", "PARTIAL",
                        "live API exposes recusal controls but they are organizer-facing; automatic replacement was not exercised",
                        operations=[operation.get("path") for operation in recusal_ops])
        else:
            self.record("Judge self-recusal capacity top-up", "UNSUPPORTED",
                        "the live API catalog exposes no recusal operation")

        metrics = self.api("/metrics")
        if metrics.status == 200 and "text/plain" in metrics.headers.get("content-type", "") and "http_requests_total" in metrics.text:
            self.record("Prometheus metrics endpoint", "VERIFIED", "live /metrics exposes Prometheus text and request totals",
                        http_status=metrics.status, content_type=metrics.headers.get("content-type"), sample=metrics.text[:240])
        elif metrics.status == 404:
            self.record("Prometheus metrics endpoint", "UNSUPPORTED", "GET /metrics returned 404")
        else:
            self.record("Prometheus metrics endpoint", "FAILED" if metrics.status else "BLOCKED",
                        "metrics response did not contain the expected Prometheus exposition", http_status=metrics.status,
                        content_type=metrics.headers.get("content-type"), error=metrics.error, sample=metrics.text[:240])

    def _catalog_gap(self, name: str, matches: Callable[[str], bool], detail: str) -> None:
        if not self.operation_details:
            self.record(name, "BLOCKED", "the live API catalog was unavailable, so endpoint support could not be determined")
            return
        routes = sorted({str(item.get("path", "")) for item in self.operation_details if matches(str(item.get("path", "")).lower())})
        self.record(name, "BLOCKED" if routes else "UNSUPPORTED",
                    "matching HTTP operations exist but their user-facing behavior was not safely exercised" if routes else detail,
                    matching_routes=routes)

    def _check_certificates(self) -> None:
        path = self.prefix + "/certificates"
        response = self.api(path, auth=self.auth["organizer"])
        if response.status != 200:
            self.record("Issued signed certificate verification", "FAILED" if response.status else "BLOCKED",
                        "could not read issued certificates with organizer credentials", http_status=response.status, error=response.error)
            return
        try:
            report = response.json()
            certs = report.get("certificates", [])
            if not certs:
                self.record("Issued signed certificate verification", "BLOCKED",
                            "event has no issued certificate snapshot to verify", total_issued=report.get("totalIssued", 0))
                return
            certificate = certs[0]
            key = raw_ed25519_public_key(report["publicKeyPem"])
            signature = bytes.fromhex(certificate["signature"])
            valid = ed25519_verify(key, certificate_digest(certificate), signature)
            if valid and certificate.get("issuerKeyId"):
                valid = hashlib.sha256(key).hexdigest() == certificate["issuerKeyId"]
            self.record("Issued signed certificate verification", "VERIFIED" if valid else "FAILED",
                        "one live certificate signature was recomputed and checked with the issued Ed25519 public key",
                        serial=certificate.get("serial"), category=certificate.get("category"), issuer_key_id=certificate.get("issuerKeyId"), certificate_count=len(certs))
            if valid:
                event_response = self.api(self.prefix, auth=self.auth["organizer"])
                slug = event_response.json().get("event", {}).get("slug") if event_response.status == 200 else None
                if not slug:
                    self.record("Public certificate page", "BLOCKED", "event slug was unavailable for the public certificate page")
                else:
                    page_path = f"/events/{urllib.parse.quote(str(slug), safe='')}/certificates/{urllib.parse.quote(str(certificate['serial']), safe='')}"
                    page = self.api(page_path)
                    page_ok = page.status == 200 and "text/html" in page.headers.get("content-type", "") and str(certificate["serial"]) in page.text
                    self.record("Public certificate page", "VERIFIED" if page_ok else ("FAILED" if page.status else "BLOCKED"),
                                "public certificate page response inspected for HTML and the signed serial",
                                http_status=page.status, content_type=page.headers.get("content-type"), error=page.error)
        except (ValueError, KeyError, TypeError, OverflowError) as error:
            self.record("Issued signed certificate verification", "FAILED", "certificate key or signed payload could not be verified", error=str(error))


def self_test() -> None:
    # RFC 8032 test vector 1 (empty message).
    public_key = bytes.fromhex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a")
    signature = bytes.fromhex(
        "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155"
        "5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"
    )
    if not ed25519_verify(public_key, b"", signature):
        raise RuntimeError("Ed25519 RFC 8032 positive vector failed")
    corrupt = bytearray(signature)
    corrupt[0] ^= 1
    if ed25519_verify(public_key, b"", bytes(corrupt)):
        raise RuntimeError("Ed25519 RFC 8032 negative vector failed")


def print_report(results: list[Result], as_json: bool) -> None:
    if as_json:
        print(json.dumps({"results": [asdict(result) for result in results]}, indent=2, ensure_ascii=False))
        return
    for result in results:
        evidence = ""
        if result.evidence:
            brief = ", ".join(f"{key}={value!r}" for key, value in result.evidence.items())
            evidence = f" ({brief})"
        print(f"{result.status:11} {result.name}: {result.detail}{evidence}")
    counts = {status: sum(result.status == status for result in results) for status in ("VERIFIED", "FAILED", "PARTIAL", "BLOCKED", "UNSUPPORTED")}
    print("\n" + "  ".join(f"{key.lower()}={value}" for key, value in counts.items()))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config", nargs="?", type=Path, default=Path(".dogfood.toml"), help="DogFood TOML file (default: .dogfood.toml)")
    parser.add_argument("--timeout", type=float, default=5.0, help="per-request timeout in seconds (default: 5)")
    parser.add_argument("--json", action="store_true", help="emit machine-readable JSON")
    parser.add_argument("--allow-incomplete", action="store_true", help="exit 0 when there are no failures, even with blocked/unsupported checks")
    parser.add_argument("--self-test", action="store_true", help="run built-in RFC 8032 Ed25519 verifier vectors and exit")
    args = parser.parse_args(argv)
    if args.timeout <= 0:
        parser.error("--timeout must be positive")
    if args.self_test:
        self_test()
        print("PASS: RFC 8032 Ed25519 positive and negative vectors")
        return 0
    try:
        config, event_id, base_url = check_config(args.config)
    except (OSError, ValueError, KeyError, tomllib.TOMLDecodeError) as error:
        print(f"Configuration error: {error}", file=sys.stderr)
        return 2
    checker = Checker(config, event_id, Portal(base_url, args.timeout))
    try:
        checker.check_health_and_api()
        checker.check_gallery_and_t3()
        checker.check_t4()
    except Exception as error:  # Preserve completed evidence and expose an unexpected checker fault.
        checker.record("Checker execution", "FAILED", "unexpected checker error", error=f"{type(error).__name__}: {error}")
    print_report(checker.results, args.json)
    if any(item.status == "FAILED" for item in checker.results):
        return 1
    incomplete = any(item.status in ("BLOCKED", "UNSUPPORTED", "PARTIAL") for item in checker.results)
    return 2 if incomplete and not args.allow_incomplete else 0


if __name__ == "__main__":
    raise SystemExit(main())
