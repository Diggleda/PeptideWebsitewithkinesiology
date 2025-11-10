import {
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
  startAuthentication,
  startRegistration,
} from '@simplewebauthn/browser';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/browser';

export const detectPlatformPasskeySupport = async (): Promise<boolean> => {
  if (typeof window === 'undefined' || !browserSupportsWebAuthn()) {
    return false;
  }
  if (
    !window.PublicKeyCredential
    || typeof window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable !== 'function'
  ) {
    return false;
  }
  try {
    return await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
};

export const detectConditionalPasskeySupport = (): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }
  return browserSupportsWebAuthnAutofill();
};

export const beginPasskeyRegistration = async (
  options: PublicKeyCredentialCreationOptionsJSON,
): Promise<RegistrationResponseJSON> => {
  return startRegistration(options);
};

export const beginPasskeyAuthentication = async (
  options: PublicKeyCredentialRequestOptionsJSON,
  useConditionalUI = false,
): Promise<AuthenticationResponseJSON> => {
  return startAuthentication(options, useConditionalUI);
};
