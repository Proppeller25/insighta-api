const crypto = require('crypto')
const jwt = require('jsonwebtoken')
const User = require('../models/userModel')
const { setCsrfCookies, clearCsrfCookies, getCsrfToken } = require('../middleware/csrf')
require('dotenv').config()

const getGithubClientId = () => process.env.GITHUB_CLIENT_ID || 'github-client-id'
const getGithubClientSecret = () => process.env.GITHUB_CLIENT_SECRET || 'github-client-secret'
const getGithubRedirectUri = () =>
  process.env.GITHUB_REDIRECT_URI || 'http://localhost:3000/api/auth/github/callback'
const getJwtSecret = () => process.env.JWT_SECRET
const WEB_SUCCESS_REDIRECT = process.env.WEB_SUCCESS_REDIRECT || '/'

const ACCESS_TOKEN_EXPIRES_IN = process.env.ACCESS_TOKEN_EXPIRES_IN || '5m'
const REFRESH_TOKEN_EXPIRES_IN = process.env.REFRESH_TOKEN_EXPIRES_IN || '3m'
const ACCESS_TOKEN_COOKIE_MAX_AGE =
  Number(process.env.ACCESS_TOKEN_COOKIE_MAX_AGE_MS) || 5 * 60 * 1000
const REFRESH_TOKEN_COOKIE_MAX_AGE =
  Number(process.env.REFRESH_TOKEN_COOKIE_MAX_AGE_MS) || 3 * 60 * 1000
const OAUTH_PENDING_COOKIE_NAME = 'oauth_pending'
const OAUTH_STATE_COOKIE_MAX_AGE = 10 * 60 * 1000

const parseEnvList = (value) =>
  String(value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)

const getAdminGithubIds = () => parseEnvList(process.env.ADMIN_GITHUB_IDS)
const getAdminGithubEmails = () => parseEnvList(process.env.ADMIN_GITHUB_EMAILS)

const ensureGithubOAuthConfig = () => {
  if (!process.env.GITHUB_CLIENT_ID || !process.env.GITHUB_CLIENT_SECRET || !process.env.GITHUB_REDIRECT_URI) {
    throw new Error('GitHub OAuth environment variables are not fully configured')
  }
}

const ensureJwtConfig = () => {
  if (!getJwtSecret()) {
    throw new Error('JWT_SECRET not set')
  }
}

const buildAccessToken = (user) => {
  return jwt.sign(
    {
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        role: user.role
      }
    },
    getJwtSecret(),
    { expiresIn: ACCESS_TOKEN_EXPIRES_IN }
  )
}

const buildRefreshToken = (user) => {
  return jwt.sign(
    {
      user: {
        id: user._id
      },
      token_type: 'refresh',
      token_id: crypto.randomUUID()
    },
    getJwtSecret(),
    { expiresIn: REFRESH_TOKEN_EXPIRES_IN }
  )
}

const getRefreshTokenExpiryDate = () => {
  return new Date(Date.now() + REFRESH_TOKEN_COOKIE_MAX_AGE)
}

const saveLoginSession = async (user) => {
  const accessToken = buildAccessToken(user)
  const refreshToken = buildRefreshToken(user)

  user.refresh_token = refreshToken
  user.refresh_token_expires_at = getRefreshTokenExpiryDate()
  user.last_login_at = new Date()
  await user.save()

  return {
    accessToken,
    refreshToken
  }
}

const getCookieOptions = () => {
  const isProduction = process.env.NODE_ENV === 'production' || process.env.ENVIRONMENT === 'production'
  return {
    httpOnly: true,
    sameSite: isProduction ? 'none' : 'lax',
    secure: isProduction
  }
}

const setAuthCookies = (res, accessToken, refreshToken) => {
  const cookieOptions = getCookieOptions()

  res.cookie('access_token', accessToken, {
    ...cookieOptions,
    maxAge: ACCESS_TOKEN_COOKIE_MAX_AGE
  })

  res.cookie('refresh_token', refreshToken, {
    ...cookieOptions,
    maxAge: REFRESH_TOKEN_COOKIE_MAX_AGE
  })
}

const clearAuthCookies = (res) => {
  const cookieOptions = getCookieOptions()
  res.clearCookie('access_token', { ...cookieOptions, path: '/' })
  res.clearCookie('refresh_token', { ...cookieOptions, path: '/' })
}

const clearAllCookies = (req, res) => {
  const cookieOptions = { ...getCookieOptions(), path: '/' }
  const cookieNames = new Set([
    ...Object.keys(req.cookies || {}),
    ...Object.keys(req.signedCookies || {}),
    'access_token',
    'refresh_token',
    'csrfSecret',
    'XSRF-TOKEN',
    OAUTH_PENDING_COOKIE_NAME
  ])

  cookieNames.forEach((cookieName) => {
    const signed = Boolean(req.signedCookies?.[cookieName])
    res.clearCookie(cookieName, { ...cookieOptions, signed })
  })
}

const setOauthPendingCookie = (res, pendingLoginData) => {
  res.cookie(OAUTH_PENDING_COOKIE_NAME, JSON.stringify(pendingLoginData), {
    ...getCookieOptions(),
    httpOnly: true,
    maxAge: OAUTH_STATE_COOKIE_MAX_AGE,
    signed: true
  })
}

const readOauthPendingCookie = (req) => {
  const encodedValue = req.signedCookies?.[OAUTH_PENDING_COOKIE_NAME]
  if (!encodedValue) return null

  try {
    return JSON.parse(encodedValue)
  } catch (error) {
    return null
  }
}

const clearOauthPendingCookie = (res) => {
  res.clearCookie(OAUTH_PENDING_COOKIE_NAME, {
    ...getCookieOptions(),
    httpOnly: true,
    signed: true
  })
}

const createStateValue = (mode) => {
  const stateObject = {
    nonce: crypto.randomUUID(),
    mode: mode === 'cli' ? 'cli' : 'web'
  }

  return Buffer.from(JSON.stringify(stateObject)).toString('base64url')
}

const readStateValue = (stateValue) => {
  if (!stateValue) return null

  try {
    const decoded = Buffer.from(stateValue, 'base64url').toString('utf8')
    return JSON.parse(decoded)
  } catch (error) {
    return null
  }
}

const buildGithubAuthorizeUrl = (state, codeChallenge) => {
  const url = new URL('https://github.com/login/oauth/authorize')

  url.searchParams.set('client_id', getGithubClientId())
  url.searchParams.set('redirect_uri', getGithubRedirectUri())
  url.searchParams.set('scope', 'read:user user:email')
  url.searchParams.set('state', state)

  if (codeChallenge) {
    url.searchParams.set('code_challenge', codeChallenge)
    url.searchParams.set('code_challenge_method', 'S256')
  }

  return url.toString()
}

const exchangeGithubCodeForToken = async (code, codeVerifier, redirectUri) => {
  const requestBody = {
    client_id: getGithubClientId(),
    client_secret: getGithubClientSecret(),
    code,
    redirect_uri: redirectUri || getGithubRedirectUri()
  }

  if (codeVerifier) {
    requestBody.code_verifier = codeVerifier
  }

  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(requestBody)
  })

  if (!response.ok) {
    throw new Error('Failed to exchange GitHub authorization code')
  }

  const data = await response.json()

  if (!data.access_token) {
    throw new Error(data.error_description || 'GitHub did not return an access token')
  }

  return data.access_token
}

const fetchGithubUserProfile = async (githubAccessToken) => {
  const response = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${githubAccessToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Insighta-Labs'
    }
  })

  if (!response.ok) {
    throw new Error('Failed to fetch GitHub user profile')
  }

  const userData = await response.json()

  if (userData.email) {
    return userData
  }

  const emailResponse = await fetch('https://api.github.com/user/emails', {
    headers: {
      Authorization: `Bearer ${githubAccessToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Insighta-Labs'
    }
  })

  if (!emailResponse.ok) {
    return userData
  }

  const emails = await emailResponse.json()
  const bestEmail =
    emails.find((item) => item.primary) ||
    emails.find((item) => item.verified) ||
    emails[0]

  return {
    ...userData,
    email: bestEmail?.email || userData.email
  }
}

const findOrCreateUserFromGithub = async (githubUser) => {
  const githubId = String(githubUser.id)
  const username = githubUser.login
  const email = githubUser.email || `${username}@users.noreply.github.com`
  const emailKey = email.toLowerCase()
  const adminGithubIds = getAdminGithubIds()
  const adminGithubEmails = getAdminGithubEmails()
  const shouldBeAdmin = adminGithubIds.includes(githubId.toLowerCase()) || adminGithubEmails.includes(emailKey)

  let user = await User.findOne({ github_id: githubId })

  if (!user) {
    user = new User({
      github_id: githubId,
      username,
      email,
      avatar_url: githubUser.avatar_url,
      role: shouldBeAdmin ? 'admin' : 'analyst',
      is_active: true
    })
  } else {
    user.username = username
    user.email = email
    user.avatar_url = githubUser.avatar_url
    if (shouldBeAdmin) {
      user.role = 'admin'
    }
    user.is_active = true
  }

  return user
}

const sendCliLoginResponse = (res, user, accessToken, refreshToken) => {
  return res.status(200).json({
    status: 'success',
    access_token: accessToken,
    refresh_token: refreshToken,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role
    }
  })
}

const redirectToGithub = async (req, res) => {
  try {
    ensureJwtConfig()
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*')
    res.setHeader('Access-Control-Allow-Credentials', 'true')

    const mode = req.query.mode === 'cli' ? 'cli' : 'web'
    let codeChallenge = ''
    let codeVerifier = ''

    if (mode === 'web') {
      // Generate PKCE verifier & challenge server-side for web
      codeVerifier = crypto.randomBytes(32).toString('base64url')
      const hash = crypto.createHash('sha256').update(codeVerifier).digest()
      codeChallenge = hash.toString('base64url')
      
      // Store verifier in a signed, httpOnly cookie (valid for 10 minutes)
      res.cookie('oauth_pkce_verifier', codeVerifier, {
        ...getCookieOptions(),
        signed: true,
        maxAge: OAUTH_STATE_COOKIE_MAX_AGE
      })
    } else {
      // CLI mode: accept code_challenge from query param (if provided)
      codeChallenge = typeof req.query.code_challenge === 'string' ? req.query.code_challenge : ''
    }

    const state = createStateValue(mode)
    const githubAuthorizeUrl = buildGithubAuthorizeUrl(state, codeChallenge)

    setOauthPendingCookie(res, {
      state,
      mode,
      pkceRequired: mode === 'cli' && Boolean(codeChallenge)   // only CLI may require verifier later
    })
    return res.redirect(githubAuthorizeUrl)
  } catch (error) {
    return res.status(500).json({ status: 'error', message: error.message || 'Server error' })
  }
}

const githubCallback = async (req, res) => {
  try {
    ensureGithubOAuthConfig()
    ensureJwtConfig()

    const code = req.query.code
    const state = req.query.state

    if (!code) {
      return res.status(400).json({ status: 'error', message: 'Authorization code is missing' });
    }
    if (!state) {
      return res.status(400).json({ status: 'error', message: 'State parameter is missing' });
    }
    // Read the pending login data from the cookie
    const pendingLogin = readOauthPendingCookie(req)
    const stateData = readStateValue(state)

    if (!pendingLogin || !stateData) {
      return res.status(400).json({ status: 'error', message: 'Invalid OAuth state' })
    }

    // Verify state matches
    if (pendingLogin.state !== state) {
      return res.status(400).json({ status: 'error', message: 'State mismatch' })
    }

    let codeVerifier = null

    // Determine source of PKCE verifier based on mode
    if (stateData.mode === 'web') {
      // Web: read from signed cookie (set in redirectToGithub)
      codeVerifier = req.signedCookies?.oauth_pkce_verifier
      // Clear the cookie after use (one-time)
      res.clearCookie('oauth_pkce_verifier', { ...getCookieOptions(), signed: true })
    } else {
      // CLI: get from query parameter
      codeVerifier = req.query.code_verifier
    }

    if (pendingLogin.pkceRequired && !codeVerifier) {
      return res.status(400).json({ status: 'error', message: 'PKCE code verifier is required for this login flow' })
    }

    const githubAccessToken = await exchangeGithubCodeForToken(code, codeVerifier)
    const githubUser = await fetchGithubUserProfile(githubAccessToken)
    const user = await findOrCreateUserFromGithub(githubUser)
    const { accessToken, refreshToken } = await saveLoginSession(user)
    clearOauthPendingCookie(res)

    if (stateData.mode === 'cli') {
      return sendCliLoginResponse(res, user, accessToken, refreshToken)
    }

    setAuthCookies(res, accessToken, refreshToken)
    setCsrfCookies(res)
    return res.redirect(WEB_SUCCESS_REDIRECT)
  } catch (error) {
    return res.status(400).json({
      status: 'error',
      message: error.message || 'Server error'
    })
  }
}

const refreshToken = async (req, res) => {
  try {
    ensureJwtConfig()

    const incomingRefreshToken =
      req.body?.refresh_token || req.cookies?.refresh_token

    if (!incomingRefreshToken) {
      return res.status(401).json({
        status: 'error',
        message: 'Refresh token is required'
      })
    }

    const decoded = jwt.verify(incomingRefreshToken, getJwtSecret())

    if (decoded.token_type !== 'refresh') {
      return res.status(401).json({
        status: 'error',
        message: 'Invalid refresh token'
      })
    }

    const userId = decoded?.user?.id
    const user = await User.findById(userId)

    if (!user) {
      return res.status(401).json({
        status: 'error',
        message: 'User not found'
      })
    }

    if (!user.is_active) {
      return res.status(403).json({
        status: 'error',
        message: 'User account is inactive'
      })
    }

    const tokenDoesNotMatch = user.refresh_token !== incomingRefreshToken
    const tokenMissing = !user.refresh_token
    const tokenHasExpired =
      !user.refresh_token_expires_at ||
      user.refresh_token_expires_at.getTime() <= Date.now()

    if (tokenMissing || tokenDoesNotMatch || tokenHasExpired) {
      return res.status(401).json({
        status: 'error',
        message: 'Refresh token is invalid or expired'
      })
    }

    const newSession = await saveLoginSession(user)

    if (req.cookies?.refresh_token) {
      setAuthCookies(res, newSession.accessToken, newSession.refreshToken)
    }

    return res.status(200).json({
      status: 'success',
      access_token: newSession.accessToken,
      refresh_token: newSession.refreshToken
    })
  } catch (error) {
    return res.status(401).json({
      status: 'error',
      message: error.message || 'Invalid refresh token'
    })
  }
}

const issueCsrfToken = async (req, res) => {
  try {
    const csrfToken = getCsrfToken(req, res)

    return res.status(200).json({
      status: 'success',
      csrfToken
    })
  } catch (error) {
    return res.status(500).json({
      status: 'error',
      message: error.message || 'Unable to issue CSRF token'
    })
  }
}

const logout = async (req, res) => {
  try {
    const incomingRefreshToken =
      req.body?.refresh_token || req.cookies?.refresh_token

    if (incomingRefreshToken) {
      const decoded = jwt.decode(incomingRefreshToken)
      const userId = decoded?.user?.id

      if (userId) {
        const user = await User.findById(userId)

        if (user && user.refresh_token === incomingRefreshToken) {
          user.refresh_token = undefined
          user.refresh_token_expires_at = undefined
          await user.save()
        }
      }
    }

    clearAllCookies(req, res)
    clearCsrfCookies(res)
    clearOauthPendingCookie(res)

    return res.status(200).json({
      status: 'success',
      message: 'Logged out successfully'
    })
  } catch (error) {
    return res.status(500).json({
      status: 'error',
      message: error.message || 'Server error'
    })
  }
}

// CLI token-based authentication using GitHub PAT
const cliLoginWithToken = async (req, res) => {
  try {
    ensureGithubOAuthConfig()
    ensureJwtConfig()

    const { token } = req.body

    if (!token) {
      return res.status(400).json({
        status: 'error',
        message: 'GitHub token is required'
      })
    }

    // Validate the GitHub token by fetching user profile
    const githubUser = await fetchGithubUserProfile(token)
    const user = await findOrCreateUserFromGithub(githubUser)
    const { accessToken, refreshToken } = await saveLoginSession(user)

    return res.status(200).json({
      status: 'success',
      access_token: accessToken,
      refresh_token: refreshToken,
      user: {
        id: user._id,
        username: user.username,
        email: user.email
      }
    })
  } catch (error) {
    return res.status(401).json({
      status: 'error',
      message: error.message || 'Invalid GitHub token'
    })
  }
}

const cliOAuthCallback = async (req, res) => {
  try {
    const { code, code_verifier, state, redirect_uri } = req.body
    if (!code || !code_verifier) {
      return res.status(400).json({ status: 'error', message: 'Missing code or code_verifier' })
    }
    const githubAccessToken = await exchangeGithubCodeForToken(code, code_verifier, redirect_uri)
    const githubUser = await fetchGithubUserProfile(githubAccessToken)
    const user = await findOrCreateUserFromGithub(githubUser)
    const { accessToken, refreshToken } = await saveLoginSession(user)
    res.status(200).json({
      status: 'success',
      access_token: accessToken,
      refresh_token: refreshToken,
      user: { id: user._id, username: user.username, email: user.email, role: user.role }
    })
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message })
  }
}

// userController.js
const getCurrentUser = async (req, res) => {
  try {
    if (!req.user || !req.user.id) {
      return res.status(401).json({ status: 'error', message: 'Not authenticated' });
    }
    const user = await User.findById(req.user.id).select('-refresh_token -refresh_token_expires_at');
    if (!user) {
      return res.status(404).json({ status: 'error', message: 'User not found' });
    }
    res.json({
      status: 'success',
      id: user._id,
      github_id: user.github_id,
      username: user.username,
      email: user.email,
      role: user.role,
      avatar_url: user.avatar_url,
      is_active: user.is_active,
      created_at: user.created_at,
      last_login_at: user.last_login_at,
      user: {
        id: user._id,
        github_id: user.github_id,
        username: user.username,
        email: user.email,
        role: user.role,
        avatar_url: user.avatar_url,
        is_active: user.is_active,
        created_at: user.created_at,
        last_login_at: user.last_login_at
      }
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
};



module.exports = {
  redirectToGithub,
  githubCallback,
  refreshToken,
  issueCsrfToken,
  logout,
  cliLoginWithToken,
  cliOAuthCallback,
  getCurrentUser
}
