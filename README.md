# File Upload and Management API

Same-origin file management interface and Express API for validating multipart uploads and storing file contents and metadata in MongoDB GridFS.

## Requirements

- Node.js 20 or newer
- MongoDB available at the configured connection URI

## Setup

1. Install dependencies with `npm install`.
2. Set `MONGODB_URI` and any desired upload settings in `.env.local`.
3. Start MongoDB, then run `npm start` or `npm run dev`. Open `http://localhost:3000` for FIELDNOTE account access and the private file desk. This URL stays the same across server restarts.
4. Run the route tests with `npm test`.

## Configuration
## Authentication

Create an account or sign in from the FIELDNOTE screen. Registration passwords must be 12–128 characters. The server sets an HttpOnly, SameSite=Lax session cookie; the browser uses that same-origin cookie for account and file requests and does not store a session token in client-side storage. Reloading the page restores a valid session, while signing out or an expired session returns to account access.

`POST /api/auth/register` and `POST /api/auth/login` accept a JSON body containing `email` and `password`, then return `{ "user": { "id": "...", "email": "..." } }` on success. `GET /api/auth/me` returns the current user and `POST /api/auth/logout` revokes the session and clears its cookie. File routes require a valid session and expose only files owned by the signed-in account.


`MAX_FILE_SIZE_BYTES` sets the maximum upload size. `ALLOWED_MIME_TYPES` is a comma-separated list of accepted MIME types. `GRIDFS_BUCKET` sets the GridFS bucket name; MongoDB stores file documents and chunks in the bucket's standard collections.

## Endpoints

### `POST /api/files/upload`

Send `multipart/form-data` with exactly one file in the `file` field. Successful uploads return `201`:

```json
{
  "id": "66f1a2b3c4d5e6f789012345",
  "filename": "document.pdf",
  "size": 1234,
  "uploadDate": "2026-10-06T12:00:00.000Z"
}
```

### `GET /api/files/:id`

Streams the file with its stored content type and an attachment filename. Returns `404` if the file does not exist.
Add `?preview=1` to request inline rendering for browser previews; the default response remains an attachment download.

### `GET /api/files`

Returns the newest files first with safe list metadata only:

```json
{
  "files": [
    {
      "id": "66f1a2b3c4d5e6f789012345",
      "filename": "document.pdf",
      "size": 1234,
      "uploadDate": "2026-10-06T12:00:00.000Z",
      "contentType": "application/pdf"
    }
  ]
}
```

### `GET /api/config`

Returns the configured allowed MIME types and maximum upload size in bytes for the same-origin interface.

### `DELETE /api/files/:id`

Deletes the GridFS file and its chunks. Returns `200` with a confirmation message or `404` if it does not exist.

Errors use `{ "error": { "code": "...", "message": "..." } }`. Invalid IDs and malformed upload fields return `400`, oversized files return `413`, unsupported MIME types return `415`, missing files return `404`, and unexpected storage failures return `500`.