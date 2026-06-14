import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { Config } from '../config';
import fs from 'fs';
import path from 'path';

export class StorageService {
  private client: S3Client;
  private bucket: string;

  constructor() {
    this.bucket = Config.R2_BUCKET;
    this.client = new S3Client({
      region: 'auto',
      endpoint: Config.R2_ENDPOINT,
      credentials: {
        accessKeyId: Config.R2_ACCESS_KEY_ID,
        secretAccessKey: Config.R2_SECRET_ACCESS_KEY,
      },
    });
  }

  static isConfigured(): boolean {
    return !!(Config.R2_ACCESS_KEY_ID && Config.R2_SECRET_ACCESS_KEY && Config.R2_ENDPOINT);
  }

  /**
   * Upload all recording artifacts from a session directory to R2.
   * Returns the R2 prefix (folder path) where files were stored.
   */
  async uploadSession(sessionDir: string): Promise<{ prefix: string; uploadedFiles: string[] }> {
    const dirName = path.basename(sessionDir);
    // Parse timestamp from dir name: guildId_channelId_timestamp
    const parts = dirName.split('_');
    const timestamp = parseInt(parts[parts.length - 1], 10);
    const date = new Date(timestamp);
    const dateStr = date.toISOString().split('T')[0]; // YYYY-MM-DD

    const prefix = `recordings/${dateStr}/${dirName}`;
    const uploadedFiles: string[] = [];

    // Upload all files in the session directory
    const files = fs.readdirSync(sessionDir);
    for (const file of files) {
      const filePath = path.join(sessionDir, file);
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;

      // Skip raw PCM files — only upload WAV, transcripts, and metadata
      if (file.endsWith('.pcm')) continue;

      const key = `${prefix}/${file}`;
      const contentType = this.getContentType(file);
      const size = stat.size;

      console.log(`[Storage] Uploading ${file} (${(size / 1024 / 1024).toFixed(1)}MB) to R2: ${key}`);

      const fileStream = fs.createReadStream(filePath);
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: fileStream,
          ContentType: contentType,
          ContentLength: size,
        })
      );

      uploadedFiles.push(key);
      console.log(`[Storage] Uploaded ${file}`);
    }

    console.log(`[Storage] Session uploaded: ${prefix} (${uploadedFiles.length} files)`);
    return { prefix, uploadedFiles };
  }

  private getContentType(filename: string): string {
    const ext = path.extname(filename).toLowerCase();
    switch (ext) {
      case '.wav': return 'audio/wav';
      case '.txt': return 'text/plain';
      case '.srt': return 'text/plain';
      case '.json': return 'application/json';
      default: return 'application/octet-stream';
    }
  }
}
