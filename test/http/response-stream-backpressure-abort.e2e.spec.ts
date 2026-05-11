// @ts-nocheck - NestJS decorators in test files cause false positive TypeScript errors
import { NestFactory } from '@nestjs/core';
import { Controller, Get, Res, Module, INestApplication } from '@nestjs/common';
import { UwsPlatformAdapter } from '../../src/http/platform/uws-platform.adapter';
import { UwsResponse } from '../../src/http/core/response';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';

const TEST_TEMP_DIR = path.join(os.tmpdir(), 'uwestjs-response-stream-backpressure');

@Controller('stream-test')
class StreamTestController {
  @Get('large')
  async largeStream(@Res() res: UwsResponse) {
    const testFilePath = path.join(TEST_TEMP_DIR, 'large-file.bin');
    const fileStream = fs.createReadStream(testFilePath);
    const stat = fs.statSync(testFilePath);

    res.setHeader('x-is-streamed', 'true');
    await res.stream(fileStream, stat.size);
  }
}

@Module({
  controllers: [StreamTestController],
})
class TestModule {}

describe('Response Streaming - Backpressure & Abort E2E', () => {
  let app: INestApplication;
  let baseUrl: string;
  let expectedHash: string;
  const port = 13357;

  beforeAll(async () => {
    if (!fs.existsSync(TEST_TEMP_DIR)) {
      fs.mkdirSync(TEST_TEMP_DIR, { recursive: true });
    }

    const testFilePath = path.join(TEST_TEMP_DIR, 'large-file.bin');
    const testData = crypto.randomBytes(2 * 1024 * 1024); // 2MB
    fs.writeFileSync(testFilePath, testData);
    expectedHash = crypto.createHash('md5').update(testData).digest('hex');

    const adapter = new UwsPlatformAdapter({ port, maxBodySize: 10 * 1024 * 1024 });
    app = await NestFactory.create(TestModule, adapter);
    await app.init();

    await new Promise<void>((resolve, reject) => {
      adapter.listen(port, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });

    baseUrl = `http://localhost:${port}`;
  }, 10000);

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 500));

    if (fs.existsSync(TEST_TEMP_DIR)) {
      fs.rmSync(TEST_TEMP_DIR, { recursive: true, force: true });
    }
  });

  // ============================================================================
  // Response-side backpressure: slow client reader
  // ============================================================================

  it('should stream full data to a slow client without corruption', async () => {
    const chunks: Buffer[] = [];

    await new Promise<void>((resolve, reject) => {
      const req = http.get(`${baseUrl}/stream-test/large`, { agent: false }, (res) => {
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
          // Pause the response stream to simulate a slow consumer.
          // This exercises the server's backpressure handling (onWritable / drain).
          res.pause();
          setTimeout(() => res.resume(), 5);
        });

        res.on('end', () => resolve());
        res.on('error', reject);
      });

      req.on('error', reject);
    });

    const received = Buffer.concat(chunks);
    const receivedHash = crypto.createHash('md5').update(received).digest('hex');

    expect(received.length).toBe(2 * 1024 * 1024);
    expect(receivedHash).toBe(expectedHash);
  }, 15000);

  // ============================================================================
  // Client abort mid-download
  // ============================================================================

  it('should survive client abort mid-download', async () => {
    let receivedBeforeAbort = 0;

    await new Promise<void>((resolve, _reject) => {
      const req = http.get(`${baseUrl}/stream-test/large`, { agent: false }, (res) => {
        res.on('data', (chunk: Buffer) => {
          receivedBeforeAbort += chunk.length;
          // Abort after receiving ~64KB
          if (receivedBeforeAbort >= 64 * 1024) {
            res.destroy();
            req.destroy();
            resolve();
          }
        });

        res.on('error', () => {
          // Expected error due to abort
          resolve();
        });

        res.on('end', () => {
          resolve();
        });
      });

      req.on('error', () => {
        // Expected error due to abort
        resolve();
      });
    });

    expect(receivedBeforeAbort).toBeGreaterThanOrEqual(64 * 1024);

    // Wait briefly for the server to process the abort
    await new Promise((r) => setTimeout(r, 300));

    // Follow-up request to verify server is still alive
    const followUp = await new Promise<{ status: number; hash: string }>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const req = http.get(`${baseUrl}/stream-test/large`, { agent: false }, (res) => {
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          const hash = crypto.createHash('md5').update(body).digest('hex');
          resolve({ status: res.statusCode || 0, hash });
        });
        res.on('error', reject);
      });
      req.on('error', reject);
    });

    expect(followUp.status).toBe(200);
    expect(followUp.hash).toBe(expectedHash);
  }, 15000);
});
