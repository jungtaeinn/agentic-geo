# Changesets

Changesets remains configured for future JavaScript workspace packages. Python
distribution releases are authoritative in each package's `pyproject.toml`, are
built with Hatchling, and are described in package-local changelogs. Do not add
Python distribution versions to Changesets or create npm package stubs solely
to bridge Python releases into Changesets.
