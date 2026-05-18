// @ts-nocheck - NestJS decorators in test files cause false positive TypeScript errors
import { NestFactory } from '@nestjs/core';
import {
  Controller,
  Get,
  Post,
  Body,
  Res,
  Module,
  INestApplication,
  Injectable,
  PipeTransform,
  UsePipes,
} from '@nestjs/common';
import { UwsPlatformAdapter } from '../../src/http/platform/uws-platform.adapter';
import { UwsResponse } from '../../src/http/core/response';
import * as http from 'http';

// ============================================================================
// Services (for DI test)
// ============================================================================

@Injectable()
class GreeterService {
  greet(name: string): string {
    return `Hello, ${name}!`;
  }
}

@Injectable()
class CounterService {
  private count = 0;

  increment(): number {
    return ++this.count;
  }

  getCount(): number {
    return this.count;
  }
}

// ============================================================================
// Pipes (for DI-resolved pipe test)
// ============================================================================

@Injectable()
class DiPipe implements PipeTransform {
  transform(value: unknown): unknown {
    if (typeof value === 'object' && value !== null) {
      return { ...(value as object), fromPipe: true };
    }
    return value;
  }
}

// ============================================================================
// Controllers
// ============================================================================

@Controller('di-test')
class DiTestController {
  constructor(
    private readonly greeter: GreeterService,
    private readonly counter: CounterService
  ) {}

  @Get('greet')
  greet(@Res() res: UwsResponse) {
    const message = this.greeter.greet('uWestJS');
    res.status(200).json({ message });
  }

  @Post('increment')
  increment(@Res() res: UwsResponse) {
    const count = this.counter.increment();
    res.status(200).json({ count });
  }
}

@Controller('di-pipe-test')
class DiPipeTestController {
  @Post('transform')
  @UsePipes(DiPipe)
  transform(@Body() body: { value: number }, @Res() res: UwsResponse) {
    res.status(200).json({ result: body });
  }
}

@Module({
  controllers: [DiTestController, DiPipeTestController],
  providers: [GreeterService, CounterService, DiPipe],
})
class TestModule {}

// ============================================================================
// E2E Tests
// ============================================================================

describe('NestJS Integration E2E', () => {
  let app: INestApplication;
  let baseUrl: string;
  const port = 13374;

  beforeAll(async () => {
    const adapter = new UwsPlatformAdapter({
      port,
    });
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
  });

  function request(
    method: string,
    path: string,
    body?: unknown
  ): Promise<{
    status: number;
    body: Record<string, unknown> | string;
  }> {
    return new Promise((resolve, reject) => {
      const postData = body ? JSON.stringify(body) : undefined;
      const headers: Record<string, string> = {};
      if (postData) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(postData).toString();
      }

      const req = http.request(`${baseUrl}${path}`, { method, agent: false, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = { raw };
          }
          resolve({
            status: res.statusCode || 0,
            body: parsed,
          });
        });
      });
      req.setTimeout(5000, () => {
        req.destroy(new Error(`${method} ${path} timed out`));
      });
      req.on('error', reject);
      if (postData) req.write(postData);
      req.end();
    });
  }

  // ==========================================================================
  // Dependency Injection
  // ==========================================================================

  describe('dependency injection', () => {
    it('should inject service into controller and use it', async () => {
      const res = await request('GET', '/di-test/greet');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ message: 'Hello, uWestJS!' });
    });

    it('should inject service with mutable state across requests', async () => {
      const res1 = await request('POST', '/di-test/increment');
      expect(res1.status).toBe(200);
      expect(res1.body).toEqual({ count: 1 });

      const res2 = await request('POST', '/di-test/increment');
      expect(res2.status).toBe(200);
      expect(res2.body).toEqual({ count: 2 });
    });
  });

  // ==========================================================================
  // DI-resolved pipes execution
  // ==========================================================================

  describe('DI-resolved pipes execution', () => {
    it('should execute pipe resolved from DI container', async () => {
      const res = await request('POST', '/di-pipe-test/transform', { value: 5 });

      expect(res.status).toBe(200);
      // DiPipe is @Injectable() and resolved from NestJS DI container
      expect(res.body).toEqual({ result: { value: 5, fromPipe: true } });
    });
  });
});
