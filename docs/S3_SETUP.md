# S3-compatible setup

hsync supports AWS S3, Cloudflare R2, MinIO, RustFS, and compatible Signature
Version 4 services.

## Required values

- **Endpoint:** the HTTPS service endpoint. Examples include
  `https://s3.amazonaws.com`, an R2 account endpoint, or a private MinIO/RustFS
  endpoint.
- **Region:** the signing region required by the service. AWS commonly uses the
  bucket region; many self-hosted services use `us-east-1`.
- **Bucket** and **object key:** where `hsync.json` will be stored.
- **Access key ID** and **secret access key:** use credentials restricted to the
  selected bucket and object prefix.
- **Session token:** required only for temporary credentials.

Use path-style addressing for MinIO, RustFS, localhost, buckets containing dots,
or services that do not support bucket subdomains. AWS normally uses
virtual-host addressing. R2 commonly uses path-style addressing with the account
endpoint.

## CORS

The bucket must allow `HEAD`, `GET`, and `PUT` from the installed extension. It
must allow these request headers:

```text
Authorization
Content-Type
If-Match
If-None-Match
x-amz-content-sha256
x-amz-date
x-amz-security-token
```

It must expose `ETag` to the extension. hsync refuses synchronization when it
cannot read `ETag`, because safe conditional updates would otherwise be
impossible.

Prefer the exact installed extension origin when the service accepts browser-
extension origins. If the service requires a wildcard CORS origin, compensate
with narrowly scoped bucket credentials and a policy restricted to the one
inventory object or prefix. CORS is not an authorization mechanism.

## Conflict behavior

The first upload uses `If-None-Match: *`, so it cannot overwrite an existing
object. After a successful Pull or Upload, hsync records the returned ETag and
uses `If-Match` for the next upload. HTTP 409 or 412 becomes a conflict and the
user must Pull and compare before retrying.
