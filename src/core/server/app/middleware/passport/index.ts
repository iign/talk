import { NextFunction, RequestHandler, Response } from "express";
import { Redis } from "ioredis";
import Joi from "joi";
import jwt from "jsonwebtoken";
import { Db } from "mongodb";
import passport, { Authenticator } from "passport";
import now from "performance-now";

import FacebookStrategy from "talk-server/app/middleware/passport/strategies/facebook";
import GoogleStrategy from "talk-server/app/middleware/passport/strategies/google";
import { JWTStrategy } from "talk-server/app/middleware/passport/strategies/jwt";
import { createLocalStrategy } from "talk-server/app/middleware/passport/strategies/local";
import OIDCStrategy from "talk-server/app/middleware/passport/strategies/oidc";
import { validate } from "talk-server/app/request/body";
import { Config } from "talk-server/config";
import logger from "talk-server/logger";
import { User } from "talk-server/models/user";
import {
  extractJWTFromRequest,
  JWTSigningConfig,
  revokeJWT,
  SigningTokenOptions,
  signTokenString,
} from "talk-server/services/jwt";
import TenantCache from "talk-server/services/tenant/cache";
import { Request } from "talk-server/types/express";

export type VerifyCallback = (
  err?: Error | null,
  user?: User | null,
  info?: { message: string }
) => void;

export interface PassportOptions {
  config: Config;
  mongo: Db;
  redis: Redis;
  signingConfig: JWTSigningConfig;
  tenantCache: TenantCache;
}

export function createPassport(
  options: PassportOptions
): passport.Authenticator {
  // Create the authenticator.
  const auth = new Authenticator();

  // Use the LocalStrategy.
  auth.use(createLocalStrategy(options));

  // Use the OIDC Strategy.
  auth.use(new OIDCStrategy(options));

  // Use the SSOStrategy.
  auth.use(new JWTStrategy(options));

  // Use the FacebookStrategy.
  auth.use(new FacebookStrategy(options));

  // Use the GoogleStrategy.
  auth.use(new GoogleStrategy(options));

  return auth;
}

interface LogoutToken {
  jti: string;
  exp: number;
}

const LogoutTokenSchema = Joi.object().keys({
  jti: Joi.string(),
  exp: Joi.number(),
});

export async function handleLogout(redis: Redis, req: Request, res: Response) {
  // Extract the token from the request.
  const token = extractJWTFromRequest(req);
  if (!token) {
    // TODO: (wyattjoh) return a better error.
    throw new Error("logout requires a token on the request, none was found");
  }

  // Decode the token.
  const decoded = jwt.decode(token, {});
  if (!decoded) {
    // TODO: (wyattjoh) return a better error.
    throw new Error(
      "logout requires a token on the request, token was invalid"
    );
  }

  // Grab the JTI from the decoded token.
  const { jti, exp }: LogoutToken = validate(LogoutTokenSchema, decoded);

  // Compute the number of seconds that the token will be valid for.
  const validFor = exp - Date.now() / 1000;
  if (validFor > 0) {
    // Invalidate the token, the expiry is in the future and it needs to be
    // revoked.
    await revokeJWT(redis, jti, validFor);
  }

  return res.sendStatus(204);
}

export async function handleSuccessfulLogin(
  user: User,
  signingConfig: JWTSigningConfig,
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    // Talk is guaranteed at this point.
    const { tenant } = req.talk!;

    const options: SigningTokenOptions = {};

    if (tenant) {
      // Attach the tenant's id to the issued token as a `iss` claim.
      options.issuer = tenant.id;
    }

    // Grab the token.
    const token = await signTokenString(signingConfig, user, options);

    // Set the cache control headers.
    res.header("Cache-Control", "private, no-cache, no-store, must-revalidate");
    res.header("Expires", "-1");
    res.header("Pragma", "no-cache");

    // Send back the details!
    res.json({ token });
  } catch (err) {
    return next(err);
  }
}

export async function handleOAuth2Callback(
  err: Error | null,
  user: User | null,
  signingConfig: JWTSigningConfig,
  req: Request,
  res: Response,
  next: NextFunction
) {
  const path = "/embed/auth/callback";
  if (!user) {
    if (!err) {
      // TODO: (wyattjoh) replace with better error
      err = new Error("user not on request");
    }

    return res.redirect(path + `#error=${encodeURIComponent(err.message)}`);
  }

  try {
    // Talk is guaranteed at this point.
    const { tenant } = req.talk!;

    const options: SigningTokenOptions = {};

    if (tenant) {
      // Attach the tenant's id to the issued token as a `iss` claim.
      options.issuer = tenant.id;
    }

    // Grab the token.
    const token = await signTokenString(signingConfig, user, options);

    // Send back the details!
    res.redirect(path + `#accessToken=${token}`);
  } catch (err) {
    res.redirect(path + `#error=${encodeURIComponent(err.message)}`);
  }
}

/**
 * wrapCallbackAuthn will wrap a authenticators authenticate method with one that
 * will render a redirect script for a valid login by a compatible strategy.
 *
 * @param authenticator the base authenticator instance
 * @param signingConfig used to sign the tokens that are issued.
 * @param name the name of the authenticator to use
 * @param options any options to be passed to the authenticate call
 */
export const wrapOAuth2Authn = (
  authenticator: passport.Authenticator,
  signingConfig: JWTSigningConfig,
  name: string,
  options?: any
): RequestHandler => (req: Request, res, next) =>
  authenticator.authenticate(
    name,
    { ...options, session: false },
    (err: Error | null, user: User | null) => {
      handleOAuth2Callback(err, user, signingConfig, req, res, next);
    }
  )(req, res, next);

/**
 * wrapAuthn will wrap a authenticators authenticate method with one that
 * will return a valid login token for a valid login by a compatible strategy.
 *
 * @param authenticator the base authenticator instance
 * @param signingConfig used to sign the tokens that are issued.
 * @param name the name of the authenticator to use
 * @param options any options to be passed to the authenticate call
 */
export const wrapAuthn = (
  authenticator: passport.Authenticator,
  signingConfig: JWTSigningConfig,
  name: string,
  options?: any
): RequestHandler => (req: Request, res, next) => {
  const startTime = now();

  authenticator.authenticate(
    name,
    { ...options, session: false },
    (err: Error | null, user: User | null) => {
      // Compute the end time.
      const responseTime = Math.round(now() - startTime);

      logger.debug({ responseTime }, "user token generated");

      if (err) {
        return next(err);
      }
      if (!user) {
        // TODO: (wyattjoh) replace with better error.
        return next(new Error("no user on request"));
      }

      handleSuccessfulLogin(user, signingConfig, req, res, next);
    }
  )(req, res, next);
};
