const crypto = require('crypto');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const { isoBase64URL } = require('@simplewebauthn/server/helpers');
const userRepository = require('../repositories/userRepository');
const { env } = require('../config/env');
const { sanitizeUser, createAuthToken } = require('./authService');

const rpID = (env.passkeys?.rpId || '').trim() || 'localhost';
const rpName = (env.passkeys?.rpName || '').trim() || 'PepPro Marketplace';
const expectedOrigins = (env.passkeys?.origins?.length ? env.passkeys.origins : [])
  .concat([
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
  ])
  .map((value) => value && value.trim())
  .filter((value, index, array) => Boolean(value) && array.indexOf(value) === index);

const registrationChallenges = new Map();
const authenticationChallenges = new Map();

const createError = (message, status = 400) => {
  const error = new Error(message);
  error.status = status;
  return error;
};

const randomId = () => {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
};

const getUserById = (userId) => {
  const user = userRepository.findById(userId);
  if (!user) {
    throw createError('USER_NOT_FOUND', 404);
  }
  return user;
};

const ensurePasskeys = (user) => (Array.isArray(user.passkeys) ? user.passkeys : []);

const toAuthenticator = (passkey) => ({
  credentialID: isoBase64URL.toBuffer(passkey.credentialID),
  credentialPublicKey: isoBase64URL.toBuffer(passkey.publicKey),
  counter: passkey.counter || 0,
  transports: passkey.transports || [],
});

const findAuthenticatorOwner = (credentialId) => {
  const user = userRepository.findByPasskeyId(credentialId);
  if (!user) {
    throw createError('PASSKEY_NOT_FOUND', 404);
  }
  const passkeys = ensurePasskeys(user);
  const entry = passkeys.find((pk) => pk.credentialID === credentialId);
  if (!entry) {
    throw createError('PASSKEY_NOT_FOUND', 404);
  }
  return { user, entry };
};

const generateOptionsForRegistration = async (userId) => {
  const user = getUserById(userId);
  const existingPasskeys = ensurePasskeys(user);

  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userID: user.id,
    userName: user.email,
    userDisplayName: user.name || user.email,
    attestationType: 'none',
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'required',
      authenticatorAttachment: 'platform',
    },
    excludeCredentials: existingPasskeys.map((pk) => ({
      id: isoBase64URL.toBuffer(pk.credentialID),
      type: 'public-key',
    })),
  });

  const requestId = randomId();
  registrationChallenges.set(requestId, {
    challenge: options.challenge,
    userId: user.id,
    createdAt: Date.now(),
  });

  return { requestId, publicKey: options };
};

const verifyRegistration = async ({ requestId, attestationResponse, label }, userId) => {
  const pending = registrationChallenges.get(requestId);
  if (!pending || pending.userId !== userId) {
    throw createError('PASSKEY_CHALLENGE_NOT_FOUND', 400);
  }
  registrationChallenges.delete(requestId);

  const user = getUserById(userId);

  const verification = await verifyRegistrationResponse({
    response: attestationResponse,
    expectedChallenge: pending.challenge,
    expectedOrigin: expectedOrigins,
    expectedRPID: rpID,
    requireUserVerification: true,
  });

  if (!verification.verified || !verification.registrationInfo) {
    throw createError('PASSKEY_REGISTRATION_FAILED', 400);
  }

  const {
    credentialPublicKey,
    credentialID,
    counter,
    credentialDeviceType,
    credentialBackedUp,
  } = verification.registrationInfo;

  const credentialIdB64 = isoBase64URL.fromBuffer(credentialID);
  const publicKeyB64 = isoBase64URL.fromBuffer(credentialPublicKey);

  const existingPasskeys = ensurePasskeys(user);
  if (existingPasskeys.some((pk) => pk.credentialID === credentialIdB64)) {
    throw createError('PASSKEY_ALREADY_REGISTERED', 409);
  }

  const updatedUser = userRepository.update({
    ...user,
    passkeys: [
      ...existingPasskeys,
      {
        credentialID: credentialIdB64,
        publicKey: publicKeyB64,
        counter,
        transports: attestationResponse.response?.transports || [],
        deviceType: credentialDeviceType,
        backedUp: credentialBackedUp,
        createdAt: new Date().toISOString(),
        label: typeof label === 'string' && label.trim() ? label.trim() : null,
      },
    ],
  }) || user;

  return {
    verified: true,
    user: sanitizeUser(updatedUser),
  };
};

const generateOptionsForAuthentication = async (email) => {
  let user = null;
  if (email && email.trim()) {
    user = userRepository.findByEmail(email.trim());
    if (!user) {
      throw createError('EMAIL_NOT_FOUND', 404);
    }
    if (!ensurePasskeys(user).length) {
      throw createError('PASSKEY_NOT_REGISTERED', 404);
    }
  }

  const allowCredentials = user
    ? ensurePasskeys(user).map((pk) => ({
      id: isoBase64URL.toBuffer(pk.credentialID),
      type: 'public-key',
      transports: pk.transports,
    }))
    : [];

  const options = await generateAuthenticationOptions({
    rpID,
    allowCredentials,
    userVerification: 'required',
  });

  const requestId = randomId();
  authenticationChallenges.set(requestId, {
    challenge: options.challenge,
    createdAt: Date.now(),
  });

  return { requestId, publicKey: options };
};

const verifyAuthentication = async ({ requestId, assertionResponse }) => {
  const pending = authenticationChallenges.get(requestId);
  if (!pending) {
    throw createError('PASSKEY_CHALLENGE_NOT_FOUND', 400);
  }
  authenticationChallenges.delete(requestId);

  const credentialID = assertionResponse?.id;
  if (!credentialID) {
    throw createError('PASSKEY_ID_REQUIRED', 400);
  }

  const { user, entry } = findAuthenticatorOwner(credentialID);

  const verification = await verifyAuthenticationResponse({
    response: assertionResponse,
    expectedChallenge: pending.challenge,
    expectedOrigin: expectedOrigins,
    expectedRPID: rpID,
    authenticator: toAuthenticator(entry),
    requireUserVerification: true,
  });

  if (!verification.verified || !verification.authenticationInfo) {
    throw createError('PASSKEY_AUTH_FAILED', 401);
  }

  const { newCounter, credentialDeviceType, credentialBackedUp } = verification.authenticationInfo;

  const nextPasskeys = ensurePasskeys(user).map((pk) => (
    pk.credentialID === entry.credentialID
      ? {
        ...pk,
        counter: newCounter,
        deviceType: credentialDeviceType || pk.deviceType,
        backedUp: typeof credentialBackedUp === 'boolean' ? credentialBackedUp : pk.backedUp,
        lastUsedAt: new Date().toISOString(),
      }
      : pk
  ));

  const updatedUser = userRepository.update({
    ...user,
    passkeys: nextPasskeys,
    visits: (user.visits || 1) + 1,
    lastLoginAt: new Date().toISOString(),
  }) || user;

  return {
    token: createAuthToken({ id: updatedUser.id, email: updatedUser.email }),
    user: sanitizeUser(updatedUser),
  };
};

module.exports = {
  generateOptionsForRegistration,
  verifyRegistration,
  generateOptionsForAuthentication,
  verifyAuthentication,
};
