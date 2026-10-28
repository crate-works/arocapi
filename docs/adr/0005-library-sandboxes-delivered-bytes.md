# 5. The library sandboxes the bytes it delivers

Date: 2026-10-28

## Status

Accepted

## Context

Content and much Metadata come from depositors and nobody vets them. The
library served them on the API's origin under their own Content-Type and with
no other protective headers. So opening a deposited HTML or SVG file ran its
scripts on that origin, where they could reach cookies, same-origin pages and
any sign-in or admin UI the deployment hosts there.

Browsers render inline PDFs, images and text under the full policy
`default-src 'none'; style-src 'unsafe-inline'; sandbox`. That holds in
current Chrome and Firefox, and in Safari from 18.4; Safari 17.4.1 to 18.3
won't show a PDF under `sandbox`. Chrome won't play audio or
video opened directly under `sandbox`, because the media document refetches
the file from an opaque origin and fails CORS. It also won't play them under
`default-src 'none'` without `media-src`. A browser can't run script in a
media document, and `<audio>`/`<video>` elements ignore the media response's
CSP.

## Decision

Every response the library sends from a `stream`, `path` or `json` delivery,
for Content and Metadata alike, on GET and HEAD, carries:

- `X-Content-Type-Options: nosniff`
- unless its Content-Type is a single `audio/*` or `video/*` type, as a
  browser reads the last of a comma-separated list:
  `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`

`sandbox` gives the document an opaque origin and blocks its scripts.
`default-src 'none'` stops a deposited page loading outside images, fonts or
stylesheets, so it can't pass as a convincing page on the API origin or
beacon out; inline styles still render. `nosniff` keeps a file labelled as
media from being sniffed into HTML.

The headers are fixed: there's no plugin option. A deployment that needs
deposited HTML to run overrides them in its own Fastify `onSend` hook.

Redirect deliveries get none of this, as their headers can't reach the
target.

## Consequences

- Deposited HTML and SVG still display but run no scripts and load nothing
  from outside. Images and fonts embedded in them as `data:` URLs are blocked
  too.
- Opening audio or video directly plays in every browser, with no CSP
  protecting the media document.
- Safari before 18.4 downloads or fails to show inline PDFs.
- A redirect target must protect itself: it should be on an origin that holds
  no sign-ins, or send the same headers itself. A presigned S3 URL is already
  on its own origin.
