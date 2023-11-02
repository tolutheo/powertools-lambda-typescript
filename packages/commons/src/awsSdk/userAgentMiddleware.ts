import { PT_VERSION } from '../version';
import { isSdkClient } from './utils';
import type { MiddlewareArgsLike } from '../types/awsSdk';

/**
 * @internal
 */
const EXEC_ENV = process.env.AWS_EXECUTION_ENV || 'NA';
const middlewareOptions = {
  relation: 'after',
  toMiddleware: 'getUserAgentMiddleware',
  name: 'addPowertoolsToUserAgent',
  tags: ['POWERTOOLS', 'USER_AGENT'],
};

/**
 * @internal
 * returns a middleware function for the MiddlewareStack, that can be used for the SDK clients
 * @param feature
 */
const customUserAgentMiddleware = (feature: string) => {
  return <T extends MiddlewareArgsLike>(next: (arg0: T) => Promise<T>) =>
    async (args: T) => {
      const powertoolsUserAgent = `PT/${feature}/${PT_VERSION} PTEnv/${EXEC_ENV}`;
      args.request.headers[
        'user-agent'
      ] = `${args.request.headers['user-agent']} ${powertoolsUserAgent}`;

      return await next(args);
    };
};

/**
 * @internal
 * Checks if the middleware stack already has the Powertools UA middleware
 */
const hasPowertools = (middlewareStack: string[]): boolean => {
  let found = false;
  for (const middleware of middlewareStack) {
    if (middleware.includes('addPowertoolsToUserAgent')) {
      found = true;
    }
  }

  return found;
};

const addUserAgentMiddleware = (client: unknown, feature: string): void => {
  try {
    if (isSdkClient(client)) {
      if (hasPowertools(client.middlewareStack.identify())) {
        return;
      }
      client.middlewareStack.addRelativeTo(
        customUserAgentMiddleware(feature),
        middlewareOptions
      );
    } else {
      throw new Error(
        `The client provided does not match the expected interface`
      );
    }
  } catch (error) {
    console.warn('Failed to add user agent middleware', error);
  }
};

export { customUserAgentMiddleware, addUserAgentMiddleware };
