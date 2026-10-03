import { RequestContext } from './request-context';

declare global {
  namespace Express {
    interface Request {
      factoryos?: RequestContext;
    }
  }
}

export {};