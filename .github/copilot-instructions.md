# GitHub Copilot Instructions for Manak

## Overview
Manak (मानक) is a zero-dependency, self-hosted hackathon submission, calibrated judging, and Ed25519-verifiable certificates platform.
Built with Node.js 22/24, native `node:sqlite`, native `node:crypto`, and zero production npm packages.

## Guidelines for Copilot
- Always use Node.js standard library modules (`node:*`).
- Do not import external packages into `src/`.
- Ensure all relative TypeScript imports include the `.ts` extension.
- Use only erasable TypeScript syntax (no enums, no parameter properties).
- Keep all SQL tables `STRICT` in migrations.
- Respect clock and randomness determinism (`Clock`, `makeRng`).
- Adhere to strict formatting: 2-space indentation, no tabs, no trailing whitespace, LF newlines.
- To run tests: `npm test` (616 automated tests).
