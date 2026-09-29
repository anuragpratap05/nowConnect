const { S3Client } = require("@aws-sdk/client-s3");

// S3-compatible client. Locally it points at MinIO (via S3_ENDPOINT +
// forcePathStyle); in production the same code talks to real AWS S3 simply by
// leaving S3_ENDPOINT unset and providing real credentials/region via env.
//
// This mirrors the existing sesClient.js pattern — same AWS SDK v3 family
// already used for SES — so the credential + region wiring looks familiar.
//
// forcePathStyle is required for MinIO: it addresses buckets as
// `endpoint/bucket` instead of the virtual-host style `bucket.endpoint`
// that real S3 uses.
const s3Client = new S3Client({
  region: process.env.S3_REGION || "us-east-1",
  endpoint: process.env.S3_ENDPOINT || undefined,
  forcePathStyle: Boolean(process.env.S3_ENDPOINT),
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY,
    secretAccessKey: process.env.S3_SECRET_KEY,
  },
});

module.exports = { s3Client, S3_BUCKET: process.env.S3_BUCKET };
