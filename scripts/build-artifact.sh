#!/bin/sh
# Build the release artifact and print its identity.
#
# Build once, promote the same artifact. What is promoted is the image DIGEST — the content
# address of the bytes — not a tag, which can later be repointed at different bytes.
#
# Refuses to build from a dirty tree: an artifact whose source revision does not describe its
# contents cannot be tied back to anything, which defeats the point of stamping a revision.
set -e

if [ -n "$(git status --porcelain)" ]; then
  echo "Refusing to build from a dirty working tree." >&2
  echo "The stamped revision would not describe the contents of the artifact." >&2
  exit 1
fi

REVISION="$(git rev-parse HEAD)"
SHORT="$(git rev-parse --short HEAD)"
VERSION="${FL_SERVICE_VERSION:-0.5.0}"

docker build \
  --build-arg "FL_VCS_REF=${SHORT}" \
  --build-arg "FL_SERVICE_VERSION=${VERSION}" \
  -t "foundation-lab:${SHORT}" \
  . >/dev/null

# The local content digest. With a registry this would be the pushed manifest digest; the
# principle is identical and the promotion path does not change.
DIGEST="$(docker image inspect "foundation-lab:${SHORT}" --format '{{.Id}}')"

cat <<EOF
{
  "artifact": "foundation-lab:${SHORT}",
  "digest": "${DIGEST}",
  "source_revision": "${REVISION}",
  "service_version": "${VERSION}",
  "base_image_pinned_by_digest": true
}
EOF
