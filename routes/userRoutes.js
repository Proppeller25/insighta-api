const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit'); // use official package
const { ensureCsrfSecret, verifyCsrfToken } = require('../middleware/csrf');
const auth = require('../middleware/auth');
const {
  redirectToGithub,
  githubCallback,
  refreshToken,
  issueCsrfToken,
  logout,
  cliLoginWithToken,
  cliOAuthCallback,
  getCurrentUser
} = require('../controllers/userController');


const authRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({ status: 'error', message: 'Too many requests, please try again later.' });
  }
})

router.use('/auth', authRateLimit)

const allowAuthCors = (req, res, next) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*')
  res.header('Access-Control-Allow-Credentials', 'true')
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-XSRF-Token, x-xsrf-token')
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204)
  }

  return next()
}

const methodNotAllowed = (allowedMethods) => (req, res) =>
  res.status(405).json({
    status: 'error',
    message: `Method ${req.method} not allowed. Use ${allowedMethods.join(', ')}.`
  })

router.use('/auth', allowAuthCors)

router.route('/auth/github')
  .options((req, res) => res.sendStatus(204))
  .get(ensureCsrfSecret, redirectToGithub)
  .all(methodNotAllowed(['GET']))

router.route('/auth/github/callback')
  .options((req, res) => res.sendStatus(204))
  .get(githubCallback)
  .all(methodNotAllowed(['GET']))

router.route('/auth/refresh')
  .options((req, res) => res.sendStatus(204))
  .post(verifyCsrfToken, refreshToken)
  .all(methodNotAllowed(['POST']))

router.route('/auth/csrf')
  .options((req, res) => res.sendStatus(204))
  .get(ensureCsrfSecret, issueCsrfToken)
  .all(methodNotAllowed(['GET']))

router.route('/auth/logout')
  .options((req, res) => res.sendStatus(204))
  .post(verifyCsrfToken, auth, logout)
  .all(methodNotAllowed(['POST']))
router.post('/auth/cli/login', cliLoginWithToken)
router.post('/auth/cli/callback', cliOAuthCallback)
router.get('/auth/me', auth, getCurrentUser)

// 👇 Add the missing endpoint required by tests
router.get('/users/me', auth, getCurrentUser);

module.exports = router;
