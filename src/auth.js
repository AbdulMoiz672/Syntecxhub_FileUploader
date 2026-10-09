const {
  createHash,
  randomBytes,
  scrypt: scryptCallback,
  timingSafeEqual,
} = require('node:crypto');
const { promisify } = require('node:util');
const { ApiError } = require('./errors');

const scrypt = promisify(scryptCallback);
const cookieName = 'fieldnote_session';
const sessionDurationMs = 7 * 24 * 60 * 60 * 1000;
const passwordHashBytes = 64;

function normalizeEmail(value) {
  if (typeof value !== 'string') {
    throw new ApiError(400, 'INVALID_EMAIL', 'Enter a valid email address.');
  }
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ApiError(400, 'INVALID_EMAIL', 'Enter a valid email address.');
  }
  return email;
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
    throw new ApiError(400, 'INVALID_PASSWORD', 'Password must be between 12 and 128 characters.');
  }
}

async function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = await scrypt(password, salt, passwordHashBytes);
  return { salt, hash: hash.toString('hex') };
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function readCookie(request) {
  const prefix = `${cookieName}=`;
  const cookie = (request.headers.cookie || '').split(';').map((part) => part.trim())
    .find((part) => part.startsWith(prefix));
  return cookie ? cookie.slice(prefix.length) : null;
}

function sessionCookie(token, maxAge = Math.floor(sessionDurationMs / 1000)) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${cookieName}=${token}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax; Path=/${secure}`;
}

function publicUser(user) {
  return { id: user._id.toHexString(), email: user.email };
}

function createAuth(database) {
  const users = database.collection('users');
  const sessions = database.collection('sessions');

  async function createSession(userId) {
    const token = randomBytes(32).toString('base64url');
    await sessions.insertOne({
      tokenHash: hashToken(token),
      userId,
      expiresAt: new Date(Date.now() + sessionDurationMs),
    });
    return token;
  }

  async function register(emailInput, password) {
    const email = normalizeEmail(emailInput);
    validatePassword(password);
    const passwordRecord = await hashPassword(password);
    const user = {
      email,
      passwordSalt: passwordRecord.salt,
      passwordHash: passwordRecord.hash,
      createdAt: new Date(),
    };

    try {
      const result = await users.insertOne(user);
      user._id = result.insertedId;
    } catch (error) {
      if (error.code === 11000) {
        throw new ApiError(409, 'EMAIL_ALREADY_REGISTERED', 'An account with this email already exists.');
      }
      throw error;
    }

    return { user: publicUser(user), token: await createSession(user._id) };
  }

  async function login(emailInput, password) {
    const email = normalizeEmail(emailInput);
    if (typeof password !== 'string' || password.length > 128) {
      throw new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
    }

    const user = await users.findOne({ email });
    if (!user) {
      await hashPassword(password, 'fieldnote-invalid-user-salt');
      throw new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
    }

    const passwordHash = await scrypt(password, user.passwordSalt, passwordHashBytes);
    const storedHash = Buffer.from(user.passwordHash, 'hex');
    if (storedHash.length !== passwordHash.length || !timingSafeEqual(storedHash, passwordHash)) {
      throw new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
    }

    return { user: publicUser(user), token: await createSession(user._id) };
  }

  async function requireAuth(request, response, next) {
    try {
      const token = readCookie(request);
      if (!token) {
        throw new ApiError(401, 'AUTHENTICATION_REQUIRED', 'Sign in to access your files.');
      }

      const session = await sessions.findOne({
        tokenHash: hashToken(token),
        expiresAt: { $gt: new Date() },
      });
      if (!session) {
        throw new ApiError(401, 'AUTHENTICATION_REQUIRED', 'Your session has expired. Sign in again.');
      }

      const user = await users.findOne({ _id: session.userId });
      if (!user) {
        throw new ApiError(401, 'AUTHENTICATION_REQUIRED', 'Your account is unavailable. Sign in again.');
      }

      request.user = { _id: user._id, email: user.email };
      next();
    } catch (error) {
      next(error);
    }
  }

  async function logout(request) {
    const token = readCookie(request);
    if (token) {
      await sessions.deleteOne({ tokenHash: hashToken(token) });
    }
  }

  return {
    ensureIndexes() {
      return Promise.all([
        users.createIndex({ email: 1 }, { unique: true }),
        sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      ]);
    },
    register,
    login,
    logout,
    requireAuth,
    sessionCookie,
    clearSessionCookie: () => sessionCookie('', 0),
  };
}

module.exports = { createAuth };