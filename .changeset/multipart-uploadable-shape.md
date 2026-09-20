---
'@tuyau/core': patch
---

Emit a minimal `TuyauUploadable` shape for `vine.file()` fields instead of `File | Blob`.

The registry resolver expands named types into structural literals, so emitting `File | Blob` froze every member of both the DOM and the `@types/node` declarations into the generated `schema.d.ts`. As soon as one of the two libs grew a member the other one stopped being assignable in consumer apps: `@types/node >= 26.5` adding `Blob.textStream()` made browser `File` values unassignable to any `vine.file()` body field.

`ExtractBody` now maps `MultipartFile` to `TuyauUploadable` (`size`, `type`, `arrayBuffer`), a shape both a DOM and a Node `File`/`Blob` satisfy and that no lib update can invalidate. It also shrinks the generated schema: a single small literal replaces a four-variant union of full `File`/`Blob` expansions.
