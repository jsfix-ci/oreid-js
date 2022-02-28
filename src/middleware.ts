/*
    Usage Example:
    import {asyncHandler, authCallbackHandler, signCallbackHandler} from './middleware';
    let oreId = OreId({appId});
    app.use('/authcallback', asyncHandler(authCallbackHandler(oreId)));
    app.use('/signcallback', asyncHandler(signCallbackHandler(oreId)));
*/

import { NextFunction } from 'express'
import OreId from './core/oreId'
import { RequestWithParams, ResponseWithParams } from './models'

type AsyncHandlerFunc = (req: RequestWithParams, res: ResponseWithParams, next: NextFunction) => any

/* eslint-disable no-param-reassign */
/** Generic async handler for Express Middleware */
export const asyncHandler = (fn: AsyncHandlerFunc) => (
  req: RequestWithParams,
  res: ResponseWithParams,
  next: NextFunction,
) => {
  Promise.resolve(fn(req, res, next)).catch(next)
}

/** Process the response from the /auth endpoint
 *  Attach user to HTTP request */
export function authCallbackHandler(oreId: OreId) {
  return asyncHandler(async (req: RequestWithParams, res: ResponseWithParams, next: NextFunction) => {
    const { query } = req
    if (!query) {
      return {}
    }

    // oreId.errors = null

    // const response = oreId.handleAuthResponse(req.originalUrl)
    const response = oreId.auth.handleAuthCallback(req.originalUrl)
    const { accessToken, account, errors, idToken, processId, state } = response

    if (errors) {
      // oreId.errors = errors
      const error = new Error(`Errors Processing auth callback: ${errors.join(', ')}`)
      return next(error)
    }

    // Add data to request object
    req.appId = oreId.options.appId
    if (accessToken) {
      req.accessToken = accessToken
    }
    if (idToken) {
      req.idToken = idToken
    }
    if (processId) {
      req.processId = processId
    }
    if (state) {
      req.state = state
    }

    // attach user data to request object
    if (account) {
      // eslint-disable-next-line prefer-destructuring
      const user = oreId.auth.user
      await user.getInfo() // get user data from server
      req.user = user.info
    }

    return next()
  })
}

/** Process the response from the /sign endpoint
 * Attach signedTransaction to HTTP request */
export function signCallbackHandler(oreId: OreId) {
  return asyncHandler(async (req: RequestWithParams, res: ResponseWithParams, next: NextFunction) => {
    const { body } = req
    if (!body) {
      return {}
    }

    // oreId.errors = null
    const { signedTransaction, state, processId, transactionId, errors } = oreId.handleSignResponse(body)

    if (errors) {
      // oreId.errors = errors
      const error = new Error(`Errors Processing sign callback: ${errors.join(', ')}`)
      return next(error)
    }

    if (processId) {
      req.processId = processId
    }

    if (signedTransaction) {
      req.signedTransaction = signedTransaction
      req.appId = oreId.options.appId
    }

    if (transactionId) {
      req.transactionId = transactionId
    }

    // Add state to request object
    if (state) {
      req.state = state
    }

    return next()
  })
}

/** Process the response from the /new-account endpoint
 * Attach newly created account name to HTTP request */
export function newAccountCallbackHandler(oreId: OreId) {
  return asyncHandler(async (req: RequestWithParams, res: ResponseWithParams, next: NextFunction) => {
    const { body } = req
    if (!body) {
      return {}
    }

    // oreId.errors = null
    const { chainAccount, state, processId, errors } = oreId.handleNewAccountResponse(body)

    if (errors) {
      const error = new Error(`Errors Processing new account callback: ${errors.join(', ')}`)
      return next(error)
    }

    if (processId) {
      req.processId = processId
    }

    if (chainAccount) {
      req.chainAccount = chainAccount
      req.appId = oreId.options.appId
    }

    // Add state to request object
    if (state) {
      req.state = state
    }

    return next()
  })
}
