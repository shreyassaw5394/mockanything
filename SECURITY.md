# Security policy

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting on this repository (Security → Report a vulnerability). Do not open a public issue. We aim to acknowledge reports within 72 hours.

## Supported versions

The latest release on npm (`@shipatmidnight/mockanything`) receives fixes.

## Scope

Mock Anything runs locally as the user who starts it. In scope: anything that lets a web page, a remote host or a twin definition reach the user's machine or data in ways the documentation doesn't describe. Twin definitions are treated as untrusted data.

Accepted by design: a running twin's API answers browser requests (with credentials) from any `localhost` origin, so local front-ends can call it. Twin data is made up. The control API and dashboard need the per-launch token.
