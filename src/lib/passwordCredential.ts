interface StoredPasswordCredential {
  id: string;
  password: string;
  name?: string;
}

type PasswordCredentialWithPassword = Credential & { password?: string };

const isCredentialContext = (): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }
  if (window.isSecureContext) {
    return true;
  }
  const host = window.location.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
};

const getCredentialsContainer = (): CredentialsContainer | null => {
  if (!isCredentialContext()) {
    return null;
  }
  const container = navigator.credentials;
  if (!container || typeof container.get !== 'function') {
    return null;
  }
  return container;
};

export const requestStoredPasswordCredential = async (): Promise<StoredPasswordCredential | null> => {
  const container = getCredentialsContainer();
  if (!container) {
    return null;
  }

  try {
    const credential = await container.get({
      password: true,
      mediation: 'optional',
    } as CredentialRequestOptions);

    if (credential && credential.type === 'password') {
      const passwordCredential = credential as PasswordCredentialWithPassword;
      return {
        id: passwordCredential.id || '',
        password: passwordCredential.password || '',
      };
    }
  } catch (error) {
    console.debug('[Credentials] Stored credential request failed', error);
  }

  return null;
};

export const storePasswordCredential = async (id: string, password: string, name?: string): Promise<void> => {
  if (!id || !password) {
    return;
  }
  if (typeof window === 'undefined') {
    return;
  }
  const container = getCredentialsContainer();
  if (!container || typeof container.store !== 'function') {
    return;
  }
  const passwordCtor = (window as typeof window & { PasswordCredential?: typeof PasswordCredential }).PasswordCredential;
  if (typeof passwordCtor !== 'function') {
    return;
  }

  try {
    const credential = new passwordCtor({
      id,
      name: name || id,
      password,
    });
    await container.store(credential);
  } catch (error) {
    console.debug('[Credentials] Unable to store credential', error);
  }
};

export type { StoredPasswordCredential };
