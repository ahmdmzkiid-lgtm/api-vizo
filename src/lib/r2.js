import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env reliably from server directory
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config();

const accountId = process.env.CLOUDFLARE_R2_ACCOUNT_ID;
const accessKeyId = process.env.CLOUDFLARE_R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY;
const bucketName = process.env.CLOUDFLARE_R2_BUCKET_NAME || 'vizo';
const publicUrl = process.env.CLOUDFLARE_R2_PUBLIC_URL || '';

const isR2Configured = Boolean(accountId && accessKeyId && secretAccessKey);

export const r2Client = isR2Configured
  ? new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    })
  : null;

/**
 * Upload a file buffer directly to Cloudflare R2
 */
export async function uploadToR2(buffer, key, contentType) {
  if (!isR2Configured || !r2Client) {
    console.warn('[R2 Warning] Cloudflare R2 is not fully configured in .env. Returning placeholder URL.');
    return {
      key,
      url: `/uploads/mock/${key}`,
    };
  }

  const command = new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  });

  await r2Client.send(command);

  const fileUrl = publicUrl ? `${publicUrl.replace(/\/$/, '')}/${key}` : key;
  return { key, url: fileUrl };
}

/**
 * Generate a Presigned Download URL (or Public direct link)
 */
export async function getDownloadUrl(key, expiresIn = 3600) {
  if (publicUrl) {
    return `${publicUrl.replace(/\/$/, '')}/${key}`;
  }

  if (!isR2Configured || !r2Client) {
    return `/uploads/mock/${key}`;
  }

  const command = new GetObjectCommand({
    Bucket: bucketName,
    Key: key,
  });

  return await getSignedUrl(r2Client, command, { expiresIn });
}

/**
 * Delete an object from Cloudflare R2
 */
export async function deleteFromR2(key) {
  if (!isR2Configured || !r2Client) return true;

  const command = new DeleteObjectCommand({
    Bucket: bucketName,
    Key: key,
  });

  await r2Client.send(command);
  return true;
}
