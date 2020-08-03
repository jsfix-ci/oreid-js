/* eslint-disable no-param-reassign */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable no-console */
import axios from 'axios'
import { initAccessContext } from 'eos-transit'

import Helpers from './helpers'
import LocalState from './localState'
import {
  transitProviderAttributesData,
  ualProviderAttributesData,
  supportedTransitProviders,
  supportedUALProviders,
  providersNotImplemented,
} from './constants'
import {
  ApiEndpoint,
  GetNewAppAccessTokenParams,
  TransitWalletAccessContext,
  TransitWalletProviderFactory,
  TransitWalletProvider,
  OreIdOptions,
  AppAccessToken,
  ChainNetwork,
  SettingChainNetwork,
  PasswordlessApiParams,
  LoginOptions,
  AuthResponse,
  SignResponse,
  ProcessId,
  SignOptions,
  SignTransactionApiBodyParams,
  TransitProviderAttributes,
  AuthProvider,
  SignStringParams,
  TransitWallet,
  AccountName,
  PermissionName,
  ChainAccount,
  PublicKey,
  WalletPermission,
  GetOreIdAuthUrlParams,
  ExternalWalletProvider,
  ConnectToTransitProviderParams,
  ConnectToUalProviderParams,
  CustodialNewAccountApiBodyParams,
  CustodialNewAccountParams,
  CustodialMigrateAccountApiBodyParams,
  CustodialMigrateAccountParams,
  SetupTransitWalletParams,
  UalProviderAttributes,
  GetAccessTokenParams,
  Config,
  TransitAccountInfo,
  RequestType,
  AddPermissionParams,
  DiscoverOptions,
  SignWithOreIdReturn,
} from './types'

const { isNullOrEmpty } = Helpers

export default class OreId {
  constructor(options: OreIdOptions) {
    this.options = null
    this.appAccessToken = null
    this.localState = new LocalState(options)
    this.transitAccessContexts = {}
    this.cachedChainNetworks = null

    this.validateOptions(options)
    this.assertNoDuplicateProviders()
  }

  isBusy: boolean

  options: OreIdOptions

  appAccessToken: AppAccessToken

  localState: LocalState

  transitAccessContexts: { [key: string]: TransitWalletAccessContext }

  cachedChainNetworks: SettingChainNetwork[] = []

  /** compare id of EosTransitProviders and UALProviders and throw if any duplicates exist */
  async assertNoDuplicateProviders() {
    const { ualProviders, eosTransitWalletProviders } = this.options
    if (!isNullOrEmpty(eosTransitWalletProviders) && !isNullOrEmpty(ualProviders)) {
      const duplicates = eosTransitWalletProviders
        .map(makeWalletProvider => makeWalletProvider(null))
        .map(walletProvider => walletProvider.id)
        .filter(transitProvider => {
          return ualProviders.find(ualProvider => {
            return transitProvider.toLowerCase().includes(ualProvider.name.toLowerCase())
          })
        })

      // TODO: Return name of both duplicate providers (current only returns transit duplicates)
      if (!isNullOrEmpty(duplicates)) {
        throw Error(`Duplicate providers's found -> ${duplicates}. Please remove one before continuing.`)
      }
    }
  }

  // todo: handle multiple networks
  async chainNetworks() {
    if (!this.cachedChainNetworks) {
      // load the chainNetworks list from the ORE ID API
      const results = await this.getConfigFromApi(Config.Chains)
      this.cachedChainNetworks = results.chains
    }

    return this.cachedChainNetworks
  }

  async getNetworkConfig(chainNetwork: ChainNetwork) {
    const networks = await this.chainNetworks()

    const chainConfig = networks.find(n => n.network === chainNetwork)
    if (!chainConfig) {
      throw new Error(`Invalid chain network: ${chainNetwork}.`)
    }

    const { hosts } = chainConfig
    const { chainId, host, port, protocol } = hosts[0] // using first host
    return { host, port, protocol, chainId }
  }

  async getOrCreateEosTransitAccessContext(chainNetwork: ChainNetwork) {
    const { appName, eosTransitWalletProviders = [] } = this.options
    if (this.transitAccessContexts[chainNetwork]) {
      return this.transitAccessContexts[chainNetwork]
    }

    const NETWORK_CONFIG = await this.getNetworkConfig(chainNetwork)

    // create context
    const walletContext = initAccessContext({
      appName: appName || 'missing appName',
      network: NETWORK_CONFIG,
      walletProviders: eosTransitWalletProviders,
    })
    // cache for future use
    this.transitAccessContexts[chainNetwork] = walletContext
    return walletContext
  }

  // Two paths
  // send code - params: loginType and email|phone)
  // verify code - params: loginType, email|phone, and code to check
  async callPasswordlessApi(params: PasswordlessApiParams, verify = false) {
    const { provider, phone, email, code, processId } = params

    if (!provider || !(phone || email) || (verify && !code)) {
      throw new Error('Missing a required parameter')
    }

    // Choose correct endpoint - send or verify
    let passwordlessEndpoint = ApiEndpoint.PasswordLessSendCode
    if (verify) {
      passwordlessEndpoint = ApiEndpoint.PasswordLessVerifyCode
    }

    const queryParams: PasswordlessApiParams = {
      provider,
    }

    if (email) {
      queryParams.email = email
    }

    if (phone) {
      // if user passes in +12103334444, the plus sign needs to be URL encoded
      const encodedPhone = encodeURIComponent(phone)
      queryParams.phone = encodedPhone
    }

    if (verify) {
      queryParams.code = code
    }

    const data = await this.callOreIdApi(RequestType.Get, passwordlessEndpoint, queryParams, processId)
    return data
  }

  // email - localhost:8080/api/account/login-passwordless-send-code?provider=email&email=me@aikon.com
  // phone - localhost:8080/api/account/login-passwordless-send-code?provider=phone&phone=+12125551212
  async passwordlessSendCodeApi(params: PasswordlessApiParams) {
    let result = {}

    try {
      result = await this.callPasswordlessApi(params)
    } catch (error) {
      return { error }
    }

    return result
  }

  // email - localhost:8080/api/account/login-passwordless-verify-code?provider=email&email=me@aikon.com&code=473830
  // phone - localhost:8080/api/account/login-passwordless-verify-code?provider=phone&phone=12125551212&code=473830
  async passwordlessVerifyCodeApi(params: PasswordlessApiParams) {
    let result = {}

    try {
      result = await this.callPasswordlessApi(params, true)
    } catch (error) {
      return { error }
    }

    return result
  }

  async login(loginOptions: LoginOptions) {
    const { provider } = loginOptions

    if (providersNotImplemented.includes(provider)) {
      throw new Error('Not Implemented')
    }

    if (this.isUALProvider(provider) || this.isTransitProvider(provider)) {
      return this.loginWithNonOreIdProvider(loginOptions)
    }

    return this.loginWithOreId(loginOptions)
  }

  // sign transaction with keys in wallet - connect to wallet first
  async sign(signOptions: SignOptions) {
    // handle sign transaction based on provider type
    const { provider } = signOptions

    if (providersNotImplemented.includes(provider)) {
      return null
    }

    if (this.isCustodial(provider)) {
      return this.custodialSignWithOreId(signOptions)
    }

    if (this.isUALProvider(provider) || this.isTransitProvider(provider)) {
      // this flag is added to test external signing with the PIN window in OreId service
      if (!signOptions.signExternalWithOreId) {
        return this.signWithNonOreIdProvider(signOptions)
      }
    }

    return this.signWithOreId(signOptions)
  }

  // connect to wallet and discover keys
  // any new keys discovered in wallet are added to user's ORE ID record
  async discover(discoverOptions: DiscoverOptions) {
    const { provider, chainNetwork = ChainNetwork.EosMain, oreAccount, discoveryPathIndexList } = discoverOptions
    this.assertValidProvider(provider)
    let result = null

    if (this.canDiscover(provider)) {
      result = this.discoverCredentialsInWallet(chainNetwork, provider, oreAccount, discoveryPathIndexList)
    } else {
      const transitWallet = await this.setupTransitWallet({ provider, chainNetwork })

      if (this.requiresLogoutLoginToDiscover(provider)) {
        await transitWallet.logout()
        await transitWallet.login()

        this.updatePermissionsOnLogin(transitWallet, provider, oreAccount)
      } else {
        console.log('Discover not working for provider: ', provider)
      }
    }

    return result
  }

  // throw error if invalid provider
  assertValidProvider(provider: AuthProvider) {
    if (transitProviderAttributesData[provider]) {
      return true
    }
    throw new Error(`Provider ${provider} is not a valid option`)
  }

  // determine whether discovery is supported by the provider
  canDiscover(provider: AuthProvider) {
    if (this.isUALProvider(provider)) {
      return false
    }

    if (this.isTransitProvider(provider)) {
      return transitProviderAttributesData[provider].supportsDiscovery === true
    }

    return false
  }

  async loginWithOreId(loginOptions: LoginOptions): Promise<{ loginUrl: string; errors: string }> {
    const { code, email, phone, provider, state, linkToAccount, newAccountPassword, processId } = loginOptions || {}
    const { authCallbackUrl, backgroundColor } = this.options
    const args = {
      code,
      email,
      phone,
      provider,
      backgroundColor,
      callbackUrl: authCallbackUrl,
      state,
      linkToAccount,
      newAccountPassword,
      processId,
    }
    const loginUrl = await this.getOreIdAuthUrl(args)
    return { loginUrl, errors: null }
  }

  async checkIfTrxAutoSignable(signOptions: SignOptions) {
    const { serviceKey } = this.options
    if (!serviceKey) {
      throw new Error('Missing serviceKey in oreId config options - required to call auto-sign api endpoints.')
    }
    let autoSignCredentialsExist = false
    let processIdReturned = null
    const { account, chainAccount, chainNetwork, processId, transaction, signedTransaction } = signOptions

    const body = {
      account,
      chain_account: chainAccount,
      chain_network: chainNetwork,
      transaction: transaction ? Helpers.base64Encode(transaction) : null,
      signed_transaction: signedTransaction ? Helpers.base64Encode(signedTransaction) : null,
    }
    ;({ autoSignCredentialsExist, process_id: processIdReturned } = await this.callOreIdApi(
      RequestType.Post,
      ApiEndpoint.CanAutoSign,
      body,
      processId,
    ))

    return autoSignCredentialsExist
  }

  async callSignTransaction(signEndpoint: ApiEndpoint, signOptions: SignOptions, autoSign = false) {
    const {
      account,
      allowChainAccountSelection,
      broadcast,
      chainAccount,
      chainNetwork,
      expireSeconds,
      returnSignedTransaction,
      processId,
      signedTransaction: signedTransactionParam,
      transaction: transactionParam,
      userPassword,
      signatureOnly,
    } = signOptions
    const body: SignTransactionApiBodyParams = {
      account,
      broadcast,
      chain_account: chainAccount,
      chain_network: chainNetwork,
      user_password: userPassword,
      signature_only: signatureOnly,
    }

    if (allowChainAccountSelection) {
      body.allow_chain_account_selection = allowChainAccountSelection
    }

    if (autoSign) {
      body.auto_sign = autoSign
    }

    if (expireSeconds) {
      body.expire_seconds = expireSeconds
    }

    if (returnSignedTransaction) {
      body.return_signed_transaction = returnSignedTransaction
    }

    if (signedTransactionParam) {
      body.signed_transaction = Helpers.base64Encode(signedTransactionParam)
    }

    if (transactionParam) {
      body.transaction = Helpers.base64Encode(transactionParam)
    }

    if (userPassword) {
      body.user_password = userPassword
    }

    const {
      signed_transaction: signedTransaction,
      transaction_id: transactionId,
      process_id: processIdReturned,
    } = await this.callOreIdApi(RequestType.Post, signEndpoint, body, processId)

    return { processId: processIdReturned, signedTransaction, transactionId }
  }

  async autoSignTransaction(signOptions: SignOptions) {
    const signEndpoint = ApiEndpoint.TransactionSign
    const { processId, signedTransaction, transactionId } = await this.callSignTransaction(
      signEndpoint,
      signOptions,
      true,
    )
    return { processId, signedTransaction, transactionId }
  }

  async signWithOreId(signOptions: SignOptions): Promise<SignWithOreIdReturn> {
    let canAutoSign = false

    try {
      canAutoSign = await this.checkIfTrxAutoSignable(signOptions)
    } catch (error) {
      // do nothing - this will leave canAutoSign = false
      // checkIfTrxAutoSignable will throw if a serviceKey isn't provided - most callers won't have a serviceKey and cant autosign
    }

    // auto sign defaults to true if the transaction is auto signable. Developer can opt out by setting preventAutoSign to true
    const { preventAutoSign = false } = signOptions

    if (canAutoSign && !preventAutoSign) {
      const { processId, signedTransaction, transactionId } = await this.autoSignTransaction(signOptions)
      return { processId, signedTransaction, transactionId }
    }

    const { signCallbackUrl } = this.options
    signOptions.callbackUrl = signCallbackUrl
    const signUrl = await this.getOreIdSignUrl(signOptions)
    return { signUrl, errors: null }
  }

  async custodialSignWithOreId(signOptions: SignOptions) {
    const { serviceKey } = this.options
    if (!serviceKey) {
      throw new Error('Missing serviceKey in oreId config options - required to call api/custodial/new-user.')
    }

    const { processId, signedTransaction, transactionId } = await this.callSignTransaction(
      ApiEndpoint.CustodialSign,
      signOptions,
    )
    return { processId, signedTransaction, transactionId }
  }

  // OreId does not support signString
  async signString(signOptions: SignStringParams) {
    const { provider } = signOptions
    if (!this.canSignString(provider)) {
      throw Error(`The specific provider ${provider} does not support signString`)
    }

    return this.isUALProvider(provider)
      ? this.signStringWithUALProvider(signOptions)
      : this.signStringWithTransitProvider(signOptions)
  }

  canSignString(provider: AuthProvider) {
    if (this.isUALProvider(provider)) {
      return ualProviderAttributesData[provider].supportsSignArbitrary
    }

    if (this.isTransitProvider(provider)) {
      return transitProviderAttributesData[provider].supportsSignArbitrary
    }

    return false
  }

  requiresLogoutLoginToDiscover(provider: AuthProvider) {
    // this flag does not exist on ualProviderAttributes
    if (this.isTransitProvider(provider)) {
      return transitProviderAttributesData[provider].requiresLogoutLoginToDiscover
    }

    return false
  }

  defaultDiscoveryPathIndexList(provider: AuthProvider): number[] {
    // this flag does not exist on ualProviderAttributes
    if (this.isTransitProvider(provider)) {
      return transitProviderAttributesData[provider].defaultDiscoveryPathIndexList
    }

    return null
  }

  discoverOptionsForProvider(provider: AuthProvider, inPathIndexList: number[] = null) {
    // checking this first since this proves this provider
    // actually needs the pathIndexList, if it returns null, it's not a ledger
    let pathIndexList = this.defaultDiscoveryPathIndexList(provider)
    if (!isNullOrEmpty(pathIndexList)) {
      if (!isNullOrEmpty(inPathIndexList)) {
        pathIndexList = inPathIndexList
      }
    }

    if (!isNullOrEmpty(pathIndexList)) {
      return { pathIndexList }
    }

    return { pathIndexList: [] }
  }

  async signStringWithUALProvider({ provider, chainNetwork, string, chainAccount, message }: SignStringParams) {
    const { user } = await this.connectToUALProvider({ provider, chainNetwork, chainAccount })
    try {
      this.setIsBusy(true)
      const keys = await user.getKeys()
      const response = await user.signArbitrary(keys[0], string, message)
      return { signedString: response }
    } catch (error) {
      console.error(error)
      throw error
    } finally {
      this.setIsBusy(false)
    }
  }

  async signStringWithTransitProvider({ provider, chainNetwork, string, message }: SignStringParams) {
    const { transitWallet } = await this.connectToTransitProvider({ provider, chainNetwork })
    try {
      this.setIsBusy(true)
      const response = await transitWallet.signArbitrary(string, message)
      return { signedString: response }
    } catch (error) {
      console.error(error)
      throw error
    } finally {
      this.setIsBusy(false)
    }
  }

  async signWithNonOreIdProvider(signOptions: SignOptions) {
    const isUALProvider = this.isUALProvider(signOptions.provider)
    return isUALProvider ? this.signWithUALProvider(signOptions) : this.signWithTransitProvider(signOptions)
  }

  async signWithUALProvider({ provider, broadcast, chainNetwork, transaction, chainAccount }: SignOptions) {
    const { user } = await this.connectToUALProvider({ provider, chainNetwork, chainAccount })
    try {
      this.setIsBusy(true)
      const response = await user.signTransaction({ actions: [transaction] }, { broadcast })
      return { signedTransaction: response }
    } catch (error) {
      console.error(error)
      throw error
    } finally {
      this.setIsBusy(false)
    }
  }

  async signWithTransitProvider(signOptions: SignOptions) {
    const { broadcast, chainNetwork, chainAccount, transaction, provider } = signOptions
    // connect to wallet
    let response = await this.connectToTransitProvider({ provider, chainNetwork, chainAccount })
    const { transitWallet } = response

    try {
      // sign with transit wallet
      this.setIsBusy(true)
      response = await transitWallet.eosApi.transact(
        {
          actions: [transaction],
        },
        {
          broadcast,
          blocksBehind: 3,
          expireSeconds: 60,
        },
      )
    } finally {
      this.setIsBusy(false)
    }

    return { signedTransaction: response }
  }

  // create a new user account that is managed by your app
  // this requires you to provide a wallet password (aka userPassword) on behalf of the user
  async custodialNewAccount(accountOptions: CustodialNewAccountParams) {
    const { serviceKey } = this.options
    const { accountType, email, name, picture, phone, userName, userPassword, processId } = accountOptions
    const body: CustodialNewAccountApiBodyParams = {
      account_type: accountType,
      email,
      name,
      phone,
      picture,
      user_name: userName,
      user_password: userPassword,
    }
    if (!serviceKey) {
      throw new Error('Missing serviceKey in oreId config options - required to call api/custodial/new-user.')
    }

    const data = await this.callOreIdApi(RequestType.Post, ApiEndpoint.CustodialNewAccount, body, processId)

    return data
  }

  // Call the migrate-account api
  // This api migrates a virtual account to a native account (on-chain)
  // This endpoint expects the account to be a managed (custodial) account
  // ... it requires you to provide a wallet password (aka userPassword) on behalf of the user
  async custodialMigrateAccount(migrateOptions: CustodialMigrateAccountParams) {
    const { serviceKey } = this.options
    if (!serviceKey) {
      throw new Error('Missing serviceKey in oreId config options - required to call api/custodial/migrate-account.')
    }

    const { account, chainAccount, chainNetwork, processId, toType, userPassword } = migrateOptions
    const body: CustodialMigrateAccountApiBodyParams = {
      account,
      chain_account: chainAccount,
      chain_network: chainNetwork,
      to_type: toType,
      user_password: userPassword,
    }

    const { account: newAccount, process_id: processIdReturned } = await this.callOreIdApi(
      RequestType.Post,
      ApiEndpoint.CustodialMigrateAccount,
      body,
      processId,
    )

    return { account: newAccount, processId: processIdReturned }
  }

  async loginWithNonOreIdProvider(loginOptions: LoginOptions) {
    const { provider, chainAccount, chainNetwork } = loginOptions
    const isUALProvider = this.isUALProvider(provider)
    return isUALProvider
      ? this.connectToUALProvider({ provider, chainAccount, chainNetwork })
      : this.connectToTransitProvider({ provider, chainAccount, chainNetwork })
  }

  // TODO: type wallet
  async loginToUALProvider(wallet: any, chainNetwork: ChainNetwork, chainAccount: ChainAccount) {
    try {
      const users = await wallet.login(chainAccount)
      return users
    } catch (error) {
      const { message = '' } = error
      if (message.includes('unknown key (boost::tuples::tuple')) {
        throw new Error(`The account selected by the wallet for login isn't on the ${chainNetwork} chain`)
      } else {
        throw error
      }
    }
  }

  // TODO: We should cache the wallet/user object to avoid calling login everytime we need to sign
  async connectToUALProvider({
    provider,
    chainNetwork = ChainNetwork.EosMain,
    chainAccount = '',
  }: ConnectToUalProviderParams) {
    const SelectedProvider = this.options.ualProviders.find(ualProvider => ualProvider.name.toLowerCase() === provider)
    if (SelectedProvider) {
      try {
        const networkConfig = await this.getNetworkConfig(chainNetwork)
        const ualNetworkConfig = {
          chainId: networkConfig.chainId,
          rpcEndpoints: [
            {
              ...networkConfig,
            },
          ],
        }
        const wallet = new SelectedProvider([ualNetworkConfig], { appName: this.options.appName })
        await wallet.init()
        const users = await this.loginToUALProvider(wallet, chainNetwork, chainAccount)

        if (!isNullOrEmpty(users)) {
          // TODO: Handle multiple users/permissions
          // UAL doesn't return the permission so we default to active
          const user = users[0]
          const publicKeys = await user.getKeys()
          const account = await user.getAccountName()
          const permissions = [{ name: 'active', publicKey: publicKeys[0] }]
          const response = {
            isLoggedIn: true,
            account,
            permissions,
            provider,
            wallet,
            user,
          }

          await this.updatePermissionsIfNecessary(account, permissions, ualNetworkConfig.chainId, provider)

          return response
        }
      } catch (error) {
        console.log(`Failed to connect to ${provider} wallet:`, error)
        throw error
      }
    } else {
      throw Error('Provider does not match')
    }
    return null
  }

  findAccountInDiscoverData(discoveryData: any, chainAccount: ChainAccount) {
    const result = discoveryData.keyToAccountMap.find((data: any) => {
      return data.accounts.find((acct: any) => {
        return acct.account === chainAccount
      })
    })

    if (result) {
      let authorization = 'active'

      // could active not exist?  If not, then just get first permission
      // this may be completely unecessary. remove if so.
      const active = result.accounts.find((acct: any) => {
        return acct.authorization === 'active'
      })

      if (!active) {
        const [first] = result.accounts

        if (first) {
          authorization = first.authorization
        }
      }

      return { index: result.index, key: result.key, authorization }
    }

    return null
  }

  needsDiscoverToLogin(provider: AuthProvider) {
    // This is just for ledger, so we are just going to check if
    // defaultDiscoveryPathIndexList returns an array which is only set for ledger
    const list = this.defaultDiscoveryPathIndexList(provider)

    return !isNullOrEmpty(list)
  }

  // This seems like a hack, but eos-transit only works if it's done this way
  // if you have scatter for example and you login with an account, the next time you login
  // no matter what you pass to login(), you will be logged in to that account
  // you have to logout first. But you don't want to logout unless the first account isn't the right one,
  // otherwise the user would have to login everytime.
  // the user in scatter has to make sure they pick the correct account when the login window comes up
  // this should be simpler, maybe will be resolved in a future eos-transit
  async doTransitProviderLogin(
    transitWallet: TransitWallet,
    chainAccount: ChainAccount,
    provider: AuthProvider,
    retryCount = 0,
  ) {
    let info: TransitAccountInfo

    // we should store the index for ledger in the db and pass it along
    // but for now we need to discover the ledger index
    if (this.needsDiscoverToLogin(provider)) {
      // we have to discover on ledger since we don't know the index of the account
      const discoveryData = await transitWallet.discover(this.discoverOptionsForProvider(provider))

      const foundData = this.findAccountInDiscoverData(discoveryData, chainAccount)
      if (foundData) {
        info = await transitWallet.login(chainAccount, foundData.authorization)
      } else {
        throw new Error(`Account ${chainAccount} not found in wallet`)
      }
    } else {
      info = await transitWallet.login(chainAccount)
    }

    if (retryCount > 2) {
      // don't get stuck in a loop, let the transaction fail so the user will figure it out
      return
    }

    const { accountName: transitAccountName } = transitWallet?.auth || {}

    if (chainAccount && transitAccountName !== chainAccount) {
      // keep trying until the user logs in with the correct wallet
      // in scatter, it will ask you to choose an account if you logout and log back in
      // we could also call discover and login to the matching account and that would avoid a step
      await transitWallet.logout()
      this.doTransitProviderLogin(transitWallet, chainAccount, provider, retryCount + 1)
    }
  }

  async loginToTransitProvider(
    transitWallet: TransitWallet,
    provider: AuthProvider,
    chainNetwork: ChainNetwork,
    chainAccount: ChainAccount = null,
  ) {
    try {
      // if the default login is for a different account
      await this.doTransitProviderLogin(transitWallet, chainAccount, provider)
    } catch (error) {
      const { message = '' } = error
      if (message.includes('unknown key (boost::tuples::tuple')) {
        throw new Error(`The account selected by the wallet for login isn't on the ${chainNetwork} chain`)
      } else {
        throw error
      }
    } finally {
      await this.waitWhileWalletIsBusy(transitWallet, provider)
    }
  }

  async setupTransitWallet({ provider, chainNetwork }: SetupTransitWalletParams) {
    const { providerId } = transitProviderAttributesData[provider]
    const chainContext = await this.getOrCreateEosTransitAccessContext(chainNetwork)
    const transitProvider = chainContext.getWalletProviders().find(wp => wp.id === providerId)
    const transitWallet = chainContext.initWallet(transitProvider)

    try {
      await transitWallet.connect()
      await this.waitWhileWalletIsBusy(transitWallet, provider)

      return transitWallet
    } catch (error) {
      console.log(`Failed to connect to ${provider}`, error)
      throw new Error(`Failed to connect to ${provider}`)
    }
  }

  async updatePermissionsOnLogin(transitWallet: TransitWallet, provider: AuthProvider, oreAccount: AccountName = null) {
    if (transitWallet.connected) {
      const { accountName, permission, publicKey } = transitWallet.auth
      const permissions: WalletPermission[] = [{ name: permission, publicKey }] // todo: add parent permission when available

      if (transitWallet.eosApi) {
        const { chainId } = transitWallet.eosApi
        await this.updatePermissionsIfNecessary(accountName, permissions, chainId, provider, oreAccount)
      }
    }
  }

  // chainAccount is needed since login will try to use the default account (in scatter)
  // and it wil fail to sign the transaction
  async connectToTransitProvider({
    provider,
    chainNetwork = ChainNetwork.EosMain,
    chainAccount = null,
  }: ConnectToTransitProviderParams) {
    let response: any

    try {
      const transitWallet: TransitWallet = await this.setupTransitWallet({ provider, chainNetwork })

      response = { transitWallet }

      // some providers require login flow to connect (usually this means connect() does nothing but login selects an account)
      if (transitProviderAttributesData[provider].requiresLogin) {
        // if connected, but not authenticated, then login
        if (!transitWallet.authenticated) {
          await this.loginToTransitProvider(transitWallet, provider, chainNetwork, chainAccount)
        }
      }

      // If connecting also performs login
      // return login results or throw error
      if (transitWallet.connected) {
        await this.updatePermissionsOnLogin(transitWallet, provider)

        if (transitWallet.authenticated) {
          const { accountName, permission, publicKey } = transitWallet.auth
          response = {
            isLoggedIn: true,
            account: accountName,
            permissions: [{ name: permission, publicKey }], // todo: add parent permission when available
            transitWallet,
            provider,
          }
        }
      } else {
        let errorString = `${provider} not connected!`
        const { hasError, errorMessage } = transitWallet

        if (hasError) {
          errorString += ` Error: ${errorMessage}`
        }

        throw new Error(errorString)
      }
    } catch (error) {
      console.log(`Failed to connect to ${provider} wallet:`, error)
      throw error
    } finally {
      this.setIsBusy(false)
    }

    return response
  }

  async waitWhileWalletIsBusy(transitWallet: TransitWallet, provider: AuthProvider) {
    while (transitWallet.inProgress) {
      this.setIsBusy(true)
      // todo: add timeout
      // eslint-disable-next-line no-await-in-loop
      await Helpers.sleep(250)
      console.log(`connecting to ${provider} via eos-transit wallet in progress:`, transitWallet.inProgress)
    }
    this.setIsBusy(false)
  }

  async getChainNetworkByChainId(chainId: string) {
    const networks = await this.chainNetworks()
    const chainConfig = networks.find(n => n.hosts.find(h => h.chainId === chainId))

    if (!isNullOrEmpty(chainConfig)) {
      return chainConfig.network
    }
    return null
  }

  async getChainNetworkFromTransitWallet(transitWallet: TransitWallet) {
    if (transitWallet && transitWallet.eosApi) {
      const { chainId } = transitWallet.eosApi

      const networks = await this.chainNetworks()

      const chainConfig = networks.find(n => n.hosts.find(h => h.chainId === chainId))
      if (!isNullOrEmpty(chainConfig)) {
        return chainConfig.network
      }
    }
    return null
  }

  // Discover all accounts (and related permissions) in the wallet and add them to ORE ID
  // Note: Most wallets don't support discovery (as of April 2019)
  async discoverCredentialsInWallet(
    chainNetwork: ChainNetwork,
    provider: AuthProvider,
    oreAccount: AccountName,
    discoveryPathIndexList: number[],
  ) {
    let accountsAndPermissions: WalletPermission[] = []

    try {
      const transitWallet = await this.setupTransitWallet({ provider, chainNetwork })

      this.setIsBusy(true)
      const discoveryData = await transitWallet.discover(
        this.discoverOptionsForProvider(provider, discoveryPathIndexList),
      )

      // this data looks like this: keyToAccountMap[accounts[{account,permission}]] - e.g. keyToAccountMap[accounts[{'myaccount':'owner','myaccount':'active'}]]
      const credentials = discoveryData.keyToAccountMap

      for (let i = 0; i < credentials.length; i += 1) {
        const credential = credentials[i]

        const { accounts = [] } = credential
        if (accounts.length > 0) {
          const { account, authorization } = accounts[0]
          const permissions: WalletPermission[] = [
            {
              account,
              publicKey: credential.key,
              name: authorization,
              parent: null,
            },
          ]
          // eslint-disable-next-line no-await-in-loop
          const chainNetworkToUpdate = await this.getChainNetworkFromTransitWallet(transitWallet)
          // eslint-disable-next-line no-await-in-loop
          await this.addWalletPermissionstoOreIdAccount(
            account,
            chainNetworkToUpdate,
            permissions,
            oreAccount,
            provider,
          )
          accountsAndPermissions = accountsAndPermissions.concat(permissions)
        }
      }
    } finally {
      this.setIsBusy(false)
    }
    // return a list of account names and related permissions found
    return accountsAndPermissions
  }

  setIsBusy(value: boolean) {
    if (this.isBusy !== value) {
      this.isBusy = value
      if (this.options.setBusyCallback) {
        this.options.setBusyCallback(value)
      }
    }
  }

  async updatePermissionsIfNecessary(
    chainAccount: ChainAccount,
    permissions: WalletPermission[],
    chainId: string,
    provider: AuthProvider,
    oreAccount: AccountName = null,
  ) {
    let oreAcct = oreAccount

    if (!oreAcct) {
      oreAcct = this.localState.accountName()
    }

    if (oreAcct) {
      const chainNetworkToUpdate = await this.getChainNetworkByChainId(chainId)
      await this.addWalletPermissionstoOreIdAccount(chainAccount, chainNetworkToUpdate, permissions, oreAcct, provider)
    } else {
      console.log('updatePermissionsIfNecessary: oreAccount is null')
    }
  }

  // for each permission in the wallet, add to ORE ID (if not in user's record)
  async addWalletPermissionstoOreIdAccount(
    chainAccount: ChainAccount,
    chainNetwork: ChainNetwork,
    walletPermissions: WalletPermission[],
    oreAccount: AccountName,
    provider: AuthProvider,
  ) {
    if (isNullOrEmpty(oreAccount) || isNullOrEmpty(walletPermissions) || isNullOrEmpty(chainNetwork)) {
      return
    }

    const theUser = await this.getUser(oreAccount, true)

    await walletPermissions.map(async p => {
      const permission = p.name
      let parentPermission = p.parent
      if (!parentPermission) {
        // HACK: assume parent permission - its missing from the discover() results
        parentPermission = 'active'

        if (permission === 'owner') {
          parentPermission = ''
        } else if (permission === 'active') {
          parentPermission = 'owner'
        }
      }
      // filter out permission that the user already has in his record
      const skipThisPermission = theUser.permissions.some(
        up =>
          (up.chainAccount === chainAccount && up.chainNetwork === chainNetwork && up.permission === permission) ||
          permission === 'owner',
      )

      // don't add 'owner' permission and skip ones that are already stored in user's account
      if (skipThisPermission !== true) {
        // let publicKey = p.required_auth.keys[0].key; //TODO: Handle multiple keys and weights
        const { publicKey } = p
        // if call is successful, nothing is returned in response (except processId)
        await this.addPermission(
          oreAccount,
          chainAccount,
          chainNetwork,
          publicKey,
          parentPermission,
          permission,
          provider,
        )
      }
    })

    // reload user to get updated permissions
    await this.getUser(oreAccount, true)
  }

  helpTextForProvider(provider: AuthProvider) {
    if (this.isTransitProvider(provider)) {
      return transitProviderAttributesData[provider].helpText
    }

    if (this.isUALProvider(provider)) {
      return ualProviderAttributesData[provider].helpText
    }

    return null
  }

  // TODO add validation of newer options
  /**  Validates startup options */
  validateOptions(options: OreIdOptions) {
    const { appId, apiKey, oreIdUrl } = options
    let errorMessage = ''

    if (!appId) {
      errorMessage +=
        '\n --> Missing required parameter - appId. You can get an appId when you register your app with ORE ID.'
    }
    if (!apiKey) {
      errorMessage +=
        '\n --> Missing required parameter - apiKey. You can get an apiKey when you register your app with ORE ID.'
    }
    if (!oreIdUrl) {
      errorMessage += '\n --> Missing required parameter - oreIdUrl. Refer to the docs to get this value.'
    }
    if (errorMessage !== '') {
      throw new Error(`Options are missing or invalid. ${errorMessage}`)
    }

    this.options = options
  }

  // load user from local storage and call api
  // to get latest info, pass refresh = true
  async getUser(accountName: AccountName = null, refresh = false, processId: ProcessId = null) {
    // return the cached user if we have it and matches the accountName
    if (!refresh) {
      const cachedUser = this.localState.user()
      if (!isNullOrEmpty(cachedUser)) {
        if (!isNullOrEmpty(accountName)) {
          if (cachedUser.accountName === accountName) {
            return cachedUser
          }
        } else {
          return cachedUser
        }
      }
    }

    // stores user in the local state, we must await for return below to work
    // this function does nothing if accoutName is null
    await this.getUserInfoFromApi(accountName, processId)

    return this.localState.user()
  }

  // Loads settings value from the server
  // e.g. configType='chains' returns valid chain types and addresses
  async getConfig(configType: Config, processId: ProcessId = null) {
    return this.getConfigFromApi(configType, processId)
  }

  // Gets a single-use token to access the service
  async getAccessToken({ newAccountPassword, processId }: GetAccessTokenParams = {}) {
    await this.getNewAppAccessToken({ newAccountPassword, processId }) // call api
    return this.appAccessToken
  }

  // Returns a fully formed url to call the auth endpoint
  async getOreIdAuthUrl(args: GetOreIdAuthUrlParams) {
    const {
      code,
      email,
      phone,
      provider,
      callbackUrl,
      backgroundColor,
      state,
      linkToAccount,
      newAccountPassword,
      processId,
    } = args
    const { oreIdUrl } = this.options

    if (!provider || !callbackUrl) {
      throw new Error('Missing a required parameter')
    }

    const appAccessToken = await this.getAccessToken({ newAccountPassword, processId })

    // optional params
    const encodedStateParam = state ? `&state=${state}` : ''
    const linkToAccountParam = linkToAccount ? `&link_to_account=${linkToAccount}` : ''
    const processIdParam = processId ? `&process_id=${processId}` : ''

    // handle passwordless params
    const codeParam = code ? `&code=${code}` : ''
    const emailParam = email ? `&email=${email}` : ''
    let phoneParam = ''

    if (phone) {
      // if user passes in +12103334444, the plus sign needs to be URL encoded
      const encodedPhone = encodeURIComponent(phone)

      phoneParam = `&phone=${encodedPhone}`
    }

    return (
      `${oreIdUrl}/auth#app_access_token=${appAccessToken}&provider=${provider}` +
      `${codeParam}${emailParam}${phoneParam}` +
      `&callback_url=${encodeURIComponent(callbackUrl)}&background_color=${encodeURIComponent(
        backgroundColor,
      )}${linkToAccountParam}${encodedStateParam}${processIdParam}`
    )
  }

  // Returns a fully formed url to call the sign endpoint
  // chainNetwork = one of the valid options defined by the system - Ex: 'eos_main', 'eos_jungle', 'eos_kylin', 'ore_main', 'eos_test', etc.
  async getOreIdSignUrl(signOptions: SignOptions) {
    const {
      account,
      allowChainAccountSelection,
      broadcast,
      callbackUrl,
      chainNetwork,
      expireSeconds,
      processId,
      provider,
      returnSignedTransaction,
      signatureOnly,
      signedTransaction,
      state,
      transaction,
      userPassword,
    } = signOptions
    let { chainAccount } = signOptions
    const { oreIdUrl } = this.options

    if (!account || !callbackUrl || (!transaction && !signedTransaction)) {
      throw new Error('Missing a required parameter')
    }

    // default chainAccount is the same as the user's account
    if (!chainAccount) {
      chainAccount = account
    }

    const appAccessToken = await this.getAccessToken({ processId })
    const encodedTransaction = Helpers.base64Encode(transaction)
    const encodedSignedTransaction = Helpers.base64Encode(signedTransaction)
    let optionalParams = state ? `&state=${state}` : ''
    optionalParams += !isNullOrEmpty(transaction) ? `&transaction=${encodedTransaction}` : ''
    optionalParams += !isNullOrEmpty(signedTransaction) ? `&signed_transaction=${encodedSignedTransaction}` : ''
    optionalParams += !isNullOrEmpty(allowChainAccountSelection)
      ? `&allow_chain_account_selection=${allowChainAccountSelection}`
      : ''
    optionalParams += !isNullOrEmpty(expireSeconds) ? `&expire_seconds=${expireSeconds}` : ''
    optionalParams += !isNullOrEmpty(returnSignedTransaction)
      ? `&return_signed_transaction=${returnSignedTransaction}`
      : ''
    optionalParams += !isNullOrEmpty(userPassword) ? `&user_password=${userPassword}` : ''
    optionalParams += !isNullOrEmpty(signatureOnly) ? `&signature_only=${signatureOnly}` : ''
    optionalParams += !isNullOrEmpty(processId) ? `&process_id=${processId}` : ''

    // prettier-ignore
    return `${oreIdUrl}/sign#app_access_token=${appAccessToken}&account=${account}&broadcast=${broadcast}&callback_url=${encodeURIComponent(callbackUrl)}&chain_account=${chainAccount}&chain_network=${encodeURIComponent(chainNetwork)}${optionalParams}`
  }

  // Extracts the response parameters on the /auth callback URL string
  handleAuthResponse(callbackUrlString: string): AuthResponse {
    // Parses error codes and returns an errors array
    // (if there is an error_code param sent back - can have more than one error code - seperated by a ‘&’ delimeter
    // NOTE: accessToken and idToken are not usually returned from the ORE ID service - they are included here for future support
    const params = Helpers.urlParamsToArray(callbackUrlString)
    const { accessToken, account, idToken, process_id: processId, state } = params
    const errors = this.getErrorCodesFromParams(params)
    const response: any = { account }
    if (accessToken) response.accessToken = accessToken
    if (idToken) response.idToken = idToken
    if (errors) response.errors = errors
    if (processId) response.processId = processId
    if (state) response.state = state
    this.setIsBusy(false)
    return response
  }

  // Extracts the response parameters on the /sign callback URL string
  handleSignResponse(callbackUrlString: string): SignResponse {
    let signedTransaction
    const params = Helpers.urlParamsToArray(callbackUrlString)
    const {
      signed_transaction: encodedTransaction,
      process_id: processId,
      state,
      transaction_id: transactionId,
    } = params
    const errors = this.getErrorCodesFromParams(params)

    if (!errors) {
      // Decode base64 parameters
      signedTransaction = Helpers.base64DecodeSafe(encodedTransaction)
    }
    this.setIsBusy(false)
    return { signedTransaction, processId, state, transactionId, errors }
  }

  // Calls the {oreIDUrl}/api/app-token endpoint to get the appAccessToken
  async getNewAppAccessToken({ newAccountPassword, processId }: GetNewAppAccessTokenParams) {
    const response = await this.callOreIdApi(RequestType.Post, ApiEndpoint.AppToken, { newAccountPassword }, processId)
    const { appAccessToken, processId: processIdReturned } = response
    this.appAccessToken = appAccessToken
  }

  // Get the user info from ORE ID for the given user account
  async getUserInfoFromApi(account: AccountName, processId: ProcessId = null) {
    if (!isNullOrEmpty(account)) {
      const queryParams = { account }
      const response = await this.callOreIdApi(RequestType.Get, ApiEndpoint.GetUser, queryParams, processId)
      const { data, processId: processIdReturned } = this.extractProcessIdFromData(response)
      this.localState.saveUser(data)
      return data
    }

    return null
  }

  // Get the config (setting) values of a specific type
  async getConfigFromApi(configType: Config.Chains, processId: ProcessId = null) {
    if (!configType) {
      throw new Error('Missing a required parameter: configType')
    }
    const queryParams = { type: configType }
    const { values, processId: processIdReturned } =
      (await this.callOreIdApi(RequestType.Get, ApiEndpoint.GetConfig, queryParams, processId)) || {}
    if (Helpers.isNullOrEmpty(values)) {
      throw new Error(`Not able to retrieve config values for ${configType}`)
    }
    return values
  }

  // Adds a public key to an account with a specific permission name
  // The permission name must be one defined in the App Registration record (Which defines its parent permission as well as preventing adding rougue permissions)
  // This feature allows your app to hold private keys locally (for certain actions enabled by the permission) while having the associated public key in the user's account
  // chainAccount = name of the account on the chain - 12/13-digit string on EOS and Ethereum Address on ETH - it may be the same as the account
  // chainNetwork = one of the valid options defined by the system - Ex: 'eos_main', 'eos_jungle', 'eos_kylin", 'ore_main', 'eos_test', etc.
  async addPermission(
    account: AccountName,
    chainAccount: ChainAccount,
    chainNetwork: ChainNetwork,
    publicKey: PublicKey,
    parentPermission: PermissionName,
    permission: PermissionName,
    provider: AuthProvider,
    processId?: ProcessId,
  ): Promise<AddPermissionParams> {
    const optionalParams: { [key: string]: any } = {}

    if (provider) {
      optionalParams['wallet-type'] = provider
    }

    if (parentPermission) {
      optionalParams['parent-permission'] = parentPermission
    }

    const queryParams = {
      account,
      'chain-account': chainAccount,
      'chain-network': chainNetwork,
      'public-key': publicKey,
      permission,
      ...optionalParams,
    }

    // if failed, error will be thrown
    // TODO: make this a post request on the api
    const response = await this.callOreIdApi(RequestType.Get, ApiEndpoint.AddPermission, queryParams, processId)
    return response
  }

  // Helper function to call api endpoint and inject api-key
  // here params can be query params in case of a GET request or body params in case of POST request
  // processId (optional) - can be used to associate multiple calls together into a single process flow
  async callOreIdApi(
    requestMethod: RequestType,
    endpoint: ApiEndpoint,
    params: { [key: string]: any } = {},
    processId: ProcessId = null,
  ) {
    let urlString
    let response
    let data
    const { apiKey, serviceKey, oreIdUrl } = this.options
    const url = `${oreIdUrl}/api/${endpoint}`

    const headers: { [key: string]: any } = { 'api-key': apiKey }
    if (!isNullOrEmpty(serviceKey)) {
      headers['service-key'] = serviceKey
    }
    if (!isNullOrEmpty(processId)) {
      headers['process-id'] = processId
    }

    try {
      if (requestMethod === RequestType.Get) {
        if (!isNullOrEmpty(params)) {
          urlString = Object.keys(params)
            .map(key => `${key}=${params[key]}`)
            .join('&')
        }

        const urlWithParams = urlString ? `${url}?${urlString}` : url
        response = await axios.get(urlWithParams, { headers })
      }

      if (requestMethod === RequestType.Post) {
        response = await axios.post(url, JSON.stringify(params), {
          headers: { 'Content-Type': 'application/json', ...headers },
          // body: params,
        })
      }
    } catch (error) {
      ;({ data } = error.response)
      const { message } = data
      const errorCodes = this.getErrorCodesFromParams(data)
      // oreid apis pass back errorCode/errorMessages
      // also handle when a standard error message is thrown
      const errorString = errorCodes || message
      throw new Error(errorString)
    }

    ;({ data } = response)
    return data
  }

  //  Params is a javascript object representing the parameters parsed from an URL string
  getErrorCodesFromParams(params: any) {
    let errorCodes: string[]
    const errorString = params.error_code || params.errorCode
    const errorMessage = params.error_message || params.errorMessage
    if (errorString) {
      errorCodes = errorString.split(/[/?/$&]/)
    }
    if (errorCodes || errorMessage) {
      errorCodes = errorCodes || []
      errorCodes.push(errorMessage)
    }
    return errorCodes
  }

  // We don't really maintain a logged-in state
  // However, we do have local cached user data, so clear that
  logout() {
    this.localState.clear()
  }

  isCustodial(provider: AuthProvider) {
    return provider === AuthProvider.Custodial
  }

  isUALProvider(provider: AuthProvider) {
    if (supportedUALProviders.includes(provider)) {
      const { ualProviders } = this.options

      if (ualProviders) {
        const found = ualProviders.find(ualProvider => ualProvider.name.toLowerCase() === provider.toLowerCase())

        return !isNullOrEmpty(found)
      }
    }

    return false
  }

  isTransitProvider(provider: AuthProvider) {
    if (supportedTransitProviders.includes(provider)) {
      // didn't want to search the eosTransitWalletProviders in this.options
      // to get the provider id you have to call a function. I'm not sure if there are side effects of
      // calling that function.  Seems best to just see if it's not a UALProvider
      return !this.isUALProvider(provider)
    }

    return false
  }

  getWalletProviderInfo(provider: AuthProvider, type: ExternalWalletProvider) {
    if (!provider || !type) {
      return {
        ualProviderAttributes: ualProviderAttributesData,
        transitProviderAttributes: transitProviderAttributesData,
      }
    }

    if (type === ExternalWalletProvider.Transit) {
      return transitProviderAttributesData[provider]
    }

    if (type === ExternalWalletProvider.Ual) {
      return ualProviderAttributesData[provider]
    }

    return null
  }

  generateProcessId() {
    const guid = Helpers.createGuid()
    // get the last 12 digits
    const processId = guid.slice(-12)
    return processId
  }

  /** remove processId from data */
  extractProcessIdFromData(data: any) {
    let processId
    if (data.processId) {
      processId = data.processId
      delete data.processId
    }
    return { data, processId }
  }
}