
import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import type { Request, Response } from 'express';
import { logger } from '../../../../src/utils/logger.js';

mock.module('../../../../src/shared/paths.js', () => ({
  getPackageRoot: () => '/tmp/test',
}));
mock.module('../../../../src/shared/worker-utils.js', () => ({
  getWorkerPort: () => 37777,
}));

import { DataRoutes } from '../../../../src/services/worker/http/routes/DataRoutes.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

function createMockReqRes(body: any): { req: Partial<Request>; res: Partial<Response>; jsonSpy: ReturnType<typeof mock>; statusSpy: ReturnType<typeof mock> } {
  const jsonSpy = mock(() => {});
  const statusSpy = mock(() => ({ json: jsonSpy }));
  return {
    req: { body, path: '/test', query: {} } as Partial<Request>,
    res: { json: jsonSpy, status: statusSpy } as unknown as Partial<Response>,
    jsonSpy,
    statusSpy,
  };
}

function captureChain(mockApp: any, targetPath: string): (req: Request, res: Response) => Promise<void> {
  let middleware: (req: Request, res: Response, next: () => void) => void;
  let handler: (req: Request, res: Response) => Promise<void>;
  mockApp.post = mock((path: string, ...rest: any[]) => {
    if (path !== targetPath) return;
    if (rest.length === 1) {
      handler = rest[0];
    } else {
      middleware = rest[0];
      handler = rest[1];
    }
  });
  return async (req: Request, res: Response): Promise<void> => {
    if (!middleware) {
      await handler(req, res);
      return;
    }
    let nextCalled = false;
    middleware(req, res, () => {
      nextCalled = true;
    });
    if (nextCalled) await handler(req, res);
  };
}

describe('DataRoutes Type Coercion', () => {
  let routes: DataRoutes;
  let mockGetObservationsByIds: ReturnType<typeof mock>;
  let mockGetSdkSessionsBySessionIds: ReturnType<typeof mock>;

  beforeEach(() => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
      spyOn(logger, 'failure').mockImplementation(() => {}),
    ];

    mockGetObservationsByIds = mock(() => [{ id: 1 }, { id: 2 }]);
    mockGetSdkSessionsBySessionIds = mock(() => [{ id: 'abc' }]);

    const mockDbManager = {
      getStore: () => ({
        getObservationsByIds: mockGetObservationsByIds,
        getSdkSessionsBySessionIds: mockGetSdkSessionsBySessionIds,
      }),
    };

    routes = new DataRoutes(
      {} as any, // paginationHelper
      mockDbManager as any,
      {} as any, // sessionManager
      {} as any, // sseBroadcaster
      {} as any, // workerService
      Date.now()
    );
  });

  afterEach(() => {
    loggerSpies.forEach(spy => spy.mockRestore());
    mock.restore();
  });

  describe('handleGetObservationsByIds — ids coercion', () => {
    let handler: (req: Request, res: Response) => Promise<void>;

    beforeEach(() => {
      const mockApp: any = {
        get: mock(() => {}),
        delete: mock(() => {}),
        use: mock(() => {}),
      };
      handler = captureChain(mockApp, '/api/observations/batch');
      routes.setupRoutes(mockApp as any);
    });

    it('should accept a native array of numbers', async () => {
      const { req, res, jsonSpy } = createMockReqRes({ ids: [1, 2, 3] });
      await handler(req as Request, res as Response);

      expect(mockGetObservationsByIds).toHaveBeenCalledWith([1, 2, 3], expect.anything());
      expect(jsonSpy).toHaveBeenCalled();
    });

    it('should coerce a JSON-encoded string array "[1,2,3]" to native array', async () => {
      const { req, res, jsonSpy } = createMockReqRes({ ids: '[1,2,3]' });
      await handler(req as Request, res as Response);

      expect(mockGetObservationsByIds).toHaveBeenCalledWith([1, 2, 3], expect.anything());
      expect(jsonSpy).toHaveBeenCalled();
    });

    it('should coerce a comma-separated string "1,2,3" to native array', async () => {
      const { req, res, jsonSpy } = createMockReqRes({ ids: '1,2,3' });
      await handler(req as Request, res as Response);

      expect(mockGetObservationsByIds).toHaveBeenCalledWith([1, 2, 3], expect.anything());
      expect(jsonSpy).toHaveBeenCalled();
    });

    it('should reject non-integer values after coercion', () => {
      const { req, res, statusSpy } = createMockReqRes({ ids: 'foo,bar' });
      handler(req as Request, res as Response);

      expect(statusSpy).toHaveBeenCalledWith(400);
    });

    it('should reject missing ids', () => {
      const { req, res, statusSpy } = createMockReqRes({});
      handler(req as Request, res as Response);

      expect(statusSpy).toHaveBeenCalledWith(400);
    });

    it('should return empty array for empty ids array', () => {
      const { req, res, jsonSpy } = createMockReqRes({ ids: [] });
      handler(req as Request, res as Response);

      expect(jsonSpy).toHaveBeenCalledWith([]);
    });
  });

  describe('handleGetSdkSessionsByIds — memorySessionIds coercion', () => {
    let handler: (req: Request, res: Response) => Promise<void>;

    beforeEach(() => {
      const mockApp: any = {
        get: mock(() => {}),
        delete: mock(() => {}),
        use: mock(() => {}),
      };
      handler = captureChain(mockApp, '/api/sdk-sessions/batch');
      routes.setupRoutes(mockApp as any);
    });

    it('should accept a native array of strings', async () => {
      const { req, res, jsonSpy } = createMockReqRes({ memorySessionIds: ['abc', 'def'] });
      await handler(req as Request, res as Response);

      expect(mockGetSdkSessionsBySessionIds).toHaveBeenCalledWith(['abc', 'def']);
      expect(jsonSpy).toHaveBeenCalled();
    });

    it('should coerce a JSON-encoded string array to native array', async () => {
      const { req, res, jsonSpy } = createMockReqRes({ memorySessionIds: '["abc","def"]' });
      await handler(req as Request, res as Response);

      expect(mockGetSdkSessionsBySessionIds).toHaveBeenCalledWith(['abc', 'def']);
      expect(jsonSpy).toHaveBeenCalled();
    });

    it('should coerce a comma-separated string to native array', async () => {
      const { req, res, jsonSpy } = createMockReqRes({ memorySessionIds: 'abc,def' });
      await handler(req as Request, res as Response);

      expect(mockGetSdkSessionsBySessionIds).toHaveBeenCalledWith(['abc', 'def']);
      expect(jsonSpy).toHaveBeenCalled();
    });

    it('should trim whitespace from comma-separated values', async () => {
      const { req, res, jsonSpy } = createMockReqRes({ memorySessionIds: 'abc, def , ghi' });
      await handler(req as Request, res as Response);

      expect(mockGetSdkSessionsBySessionIds).toHaveBeenCalledWith(['abc', 'def', 'ghi']);
      expect(jsonSpy).toHaveBeenCalled();
    });

    it('should accept legacy sdkSessionIds as a compatibility alias', async () => {
      const { req, res, jsonSpy } = createMockReqRes({ sdkSessionIds: ['abc', 'def'] });
      await handler(req as Request, res as Response);

      expect(mockGetSdkSessionsBySessionIds).toHaveBeenCalledWith(['abc', 'def']);
      expect(jsonSpy).toHaveBeenCalled();
    });

    it('should prefer canonical memorySessionIds when both fields are provided', async () => {
      const { req, res, jsonSpy } = createMockReqRes({
        memorySessionIds: ['canonical'],
        sdkSessionIds: ['legacy'],
      });
      await handler(req as Request, res as Response);

      expect(mockGetSdkSessionsBySessionIds).toHaveBeenCalledWith(['canonical']);
      expect(jsonSpy).toHaveBeenCalled();
    });

    it('should reject non-array, non-string values', () => {
      const { req, res, statusSpy } = createMockReqRes({ memorySessionIds: 42 });
      handler(req as Request, res as Response);

      expect(statusSpy).toHaveBeenCalledWith(400);
    });
  });
});
