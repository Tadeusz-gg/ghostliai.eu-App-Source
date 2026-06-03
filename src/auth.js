
// crp 1.0.2 tks
class AuthManager {
  constructor() {
    this.isAuthenticated = false;
    this.sessionKey = null;
    this.isFirstRun = false;
    this._secureBuffers = new Set();

    const cryptoCheck = this._checkCryptoSupport();
    if (!cryptoCheck.supported) {
      throw new Error(`Crypto not supported: ${cryptoCheck.message}`);
    }

    this.CONSTANTS = Object.freeze({
      PBKDF2_ITERATIONS: 300000,
      SALT_LENGTH: 32,
      IV_LENGTH: 12,
      TAG_LENGTH: 128,
      MAX_PASSWORD_LENGTH: 256,
      MIN_PASSWORD_LENGTH: 12,
      MAX_DATA_SIZE: 100 * 1024 * 1024,
      MEMORY_WIPE_ROUNDS: 3,
      TIMING_ATTACK_DELAY: 200
    });
  }

  _secureWipe(buffer) {
    if (!buffer || !(buffer instanceof Uint8Array)) return false;

    try {
      const patterns = [0xFF, 0x00, 0xAA, 0x55, 0x33, 0xCC];
      for (let round = 0; round < this.CONSTANTS.MEMORY_WIPE_ROUNDS; round++) {
        patterns.forEach(pattern => buffer.fill(pattern));

        if (buffer.length > 0) {
          crypto.getRandomValues(buffer);
        }
      }

      buffer.fill(0);

      this._secureBuffers.delete(buffer);
      return true;
    } catch (e) {
      console.warn('Secure wipe failed:', e.message);
      return false;
    }
  }

  _trackBuffer(buffer, timeoutMs = 30000) {
    if (buffer instanceof Uint8Array) {
      this._secureBuffers.add(buffer);
      setTimeout(() => this._secureWipe(buffer), timeoutMs);
    }
    return buffer;
  }

  _cleanup() {
    this._secureBuffers.forEach(buffer => this._secureWipe(buffer));
    this._secureBuffers.clear();
  }

  _generateSecureRandom(length) {
    if (!Number.isInteger(length) || length < 1 || length > 1024) {
      throw new Error('Invalid random length requested');
    }

    const buffer = new Uint8Array(length);
    crypto.getRandomValues(buffer);

    if (buffer.every(byte => byte === 0)) {
      throw new Error('Insufficient entropy in random generation');
    }

    return this._trackBuffer(buffer);
  }

  async _deriveKeyLegacy(password, salt, iterations = 150000) {
    const encoder = new TextEncoder();
    const passwordBuffer = this._trackBuffer(encoder.encode(password));

    try {
      const keyMaterial = await crypto.subtle.importKey(
        'raw', passwordBuffer, 'PBKDF2', false, ['deriveBits']
      );

      const bits = await crypto.subtle.deriveBits(
        {
          name: 'PBKDF2',
          salt: salt,
          iterations: iterations,
          hash: 'SHA-256'
        },
        keyMaterial,
        256
      );

      return this._trackBuffer(new Uint8Array(bits));
    } finally {
      this._secureWipe(passwordBuffer);
    }
  }

  async _deriveKey(password, salt, forVerification = false) {
    if (typeof password !== 'string' || !password.trim()) {
      throw new Error('Invalid password provided');
    }

    if (!(salt instanceof Uint8Array) || salt.length !== this.CONSTANTS.SALT_LENGTH) {
      throw new Error('Invalid salt provided');
    }

    const encoder = new TextEncoder();
    const passwordBuffer = this._trackBuffer(encoder.encode(password.normalize('NFKC')));

    try {
      const keyMaterial = await crypto.subtle.importKey(
        'raw', passwordBuffer, 'PBKDF2', false,
        forVerification ? ['deriveBits'] : ['deriveBits', 'deriveKey']
      );

      if (forVerification) {
        const bits = await crypto.subtle.deriveBits(
          {
            name: 'PBKDF2',
            salt: salt,
            iterations: this.CONSTANTS.PBKDF2_ITERATIONS,
            hash: 'SHA-256'
          },
          keyMaterial,
          256
        );
        return this._trackBuffer(new Uint8Array(bits));
      } else {
        return await crypto.subtle.deriveKey(
          {
            name: 'PBKDF2',
            salt: salt,
            iterations: this.CONSTANTS.PBKDF2_ITERATIONS,
            hash: 'SHA-256'
          },
          keyMaterial,
          { name: 'AES-GCM', length: 256 },
          false,
          ['encrypt', 'decrypt']
        );
      }
    } finally {
      this._secureWipe(passwordBuffer);
    }
  }

  _constantTimeCompare(a, b) {
    if (!a || !b || a.length !== b.length) return false;

    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a[i] ^ b[i];
    }
    return result === 0;
  }

  _validatePassword(password) {
    if (typeof password !== 'string') {
      return { valid: false, message: 'Password must be a string' };
    }

    if (password.length < this.CONSTANTS.MIN_PASSWORD_LENGTH) {
      return { valid: false, message: `Password must be at least ${this.CONSTANTS.MIN_PASSWORD_LENGTH} characters long` };
    }

    if (password.length > this.CONSTANTS.MAX_PASSWORD_LENGTH) {
      return { valid: false, message: `Password must be less than ${this.CONSTANTS.MAX_PASSWORD_LENGTH} characters` };
    }

    const hasLower = /[a-z]/.test(password);
    const hasUpper = /[A-Z]/.test(password);
    const hasDigit = /\d/.test(password);
    const hasSpecial = /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?~`]/.test(password);

    const complexityCount = [hasLower, hasUpper, hasDigit, hasSpecial].filter(Boolean).length;

    if (complexityCount < 3) {
      return {
        valid: false,
        message: 'Password must contain at least 3 of: lowercase, uppercase, numbers, special characters'
      };
    }

    if (/(.)\1{3,}/.test(password)) {
      return { valid: false, message: 'Password cannot contain more than 3 consecutive identical characters' };
    }

    const commonPatterns = [
      /123456/, /abcdef/, /qwerty/, /asdfgh/, /zxcvbn/,
      /password/i, /admin/i, /login/i, /welcome/i, /master/i
    ];

    if (commonPatterns.some(pattern => pattern.test(password))) {
      return { valid: false, message: 'Password contains common patterns - please choose something more unique' };
    }

    const weakPasswords = [
      'password', '123456', 'qwerty', 'abc123', 'password123',
      'admin', 'letmein', 'welcome', 'monkey', 'dragon',
      'master', 'hello', 'login', 'princess', 'qwertyuiop',
      'password1', '12345678', 'iloveyou', 'sunshine', 'superman',
      'trustno1', 'dragon', 'master', 'hello', 'freedom',
      'whatever', 'qazwsx', 'michael', 'football', 'baseball'
    ];

    if (weakPasswords.includes(password.toLowerCase())) {
      return { valid: false, message: 'Please choose a stronger password' };
    }

    return { valid: true, message: 'Password is strong' };
  }

  _safeJSONParse(jsonString, maxSize = this.CONSTANTS.MAX_DATA_SIZE) {
    if (typeof jsonString !== 'string' || jsonString.length > maxSize) {
      throw new Error('Invalid or oversized JSON data');
    }

    try {
      return JSON.parse(jsonString);
    } catch (e) {
      throw new Error('Invalid JSON format');
    }
  }

  _toBase64(uint8Array) {
    if (!(uint8Array instanceof Uint8Array)) {
      throw new Error('Expected Uint8Array for base64 encoding');
    }


    const chunkSize = 8192;
    let result = '';

    for (let i = 0; i < uint8Array.length; i += chunkSize) {
      const chunk = uint8Array.slice(i, i + chunkSize);
      result += String.fromCharCode(...chunk);
    }

    return btoa(result);
  }

  _fromBase64(base64String) {
    if (typeof base64String !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64String)) {
      throw new Error('Invalid base64 string');
    }

    try {
      const binaryString = atob(base64String);
      return this._trackBuffer(new Uint8Array([...binaryString].map(char => char.charCodeAt(0))));
    } catch (e) {
      throw new Error('Base64 decoding failed');
    }
  }

  async _encrypt(data, key) {
    if (!data || !key) throw new Error('Invalid encryption parameters');

    const iv = this._generateSecureRandom(this.CONSTANTS.IV_LENGTH);
    const encoder = new TextEncoder();
    const jsonString = JSON.stringify(data);

    if (jsonString.length > this.CONSTANTS.MAX_DATA_SIZE) {
      throw new Error('Data too large for encryption');
    }

    const dataBuffer = this._trackBuffer(encoder.encode(jsonString));

    try {
      const encrypted = await crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: iv,
          tagLength: this.CONSTANTS.TAG_LENGTH
        },
        key,
        dataBuffer
      );

      return {
        data: this._toBase64(new Uint8Array(encrypted)),
        iv: this._toBase64(iv),
        timestamp: Date.now(),
        version: '2.1'
      };
    } finally {
      this._secureWipe(dataBuffer);
      this._secureWipe(iv);
    }
  }

  async _decrypt(encryptedPackage, key) {
    if (!encryptedPackage || !key) throw new Error('Invalid decryption parameters');

    const { data, iv, timestamp, version } = encryptedPackage;

    if (version && !['2.0', '2.1'].includes(version)) {
      throw new Error('Unsupported data version');
    }

    const maxAge = 365 * 24 * 60 * 60 * 1000;
    if (timestamp && Date.now() - timestamp > maxAge) {
      console.warn('Decrypting very old data');
    }

    const encryptedData = this._fromBase64(data);
    const ivBuffer = this._fromBase64(iv);

    try {
      const decrypted = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: ivBuffer,
          tagLength: this.CONSTANTS.TAG_LENGTH
        },
        key,
        encryptedData
      );

      const decoder = new TextDecoder();
      const jsonString = decoder.decode(decrypted);
      return this._safeJSONParse(jsonString);
    } catch (e) {
      throw new Error('Decryption failed - invalid password or corrupted data');
    } finally {
      this._secureWipe(encryptedData);
      this._secureWipe(ivBuffer);
    }
  }

  _checkCryptoSupport() {
    if (!window.crypto?.subtle) {
      return { supported: false, message: 'Web Crypto API not available' };
    }

    const requiredMethods = ['importKey', 'deriveKey', 'deriveBits', 'encrypt', 'decrypt'];
    const missing = requiredMethods.find(method => !crypto.subtle[method]);

    if (missing) {
      return { supported: false, message: `Missing crypto method: ${missing}` };
    }

    return { supported: true, message: 'All crypto features supported' };
  }

  _getStorageItem(key) {
    try {
      const item = localStorage.getItem(key);
      return item ? this._safeJSONParse(item) : null;
    } catch (e) {
      console.warn(`Failed to read ${key}:`, e.message);
      return null;
    }
  }

  _setStorageItem(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      console.error(`Failed to write ${key}:`, e.message);
      return false;
    }
  }



  async _loadAuthData() {
    let authData = null;

    if (window.electronAPI && window.electronAPI.dbGet) {
      try {
        const result = await window.electronAPI.dbGet('ghostli_auth_data');
        if (result.success && result.value) {
          authData = JSON.parse(result.value);
        }
      } catch (e) {
        console.warn('Failed to read auth_data from DB:', e);
      }
    }

    if (!authData) {
      authData = this._getStorageItem('ghostli_auth_data');

      if (authData && window.electronAPI && window.electronAPI.dbSet) {
        window.electronAPI.dbSet('ghostli_auth_data', JSON.stringify(authData)).catch(console.error);
      }
    } else {

      this._setStorageItem('ghostli_auth_data', authData);
    }

    return authData;
  }

  async isFirstRunCheck() {
    const data = await this._loadAuthData();
    return !data;
  }

  async initialize() {
    try {
      this.isFirstRun = await this.isFirstRunCheck();
      return { isFirstRun: this.isFirstRun, success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  async setupPassword(password) {
    const validation = this._validatePassword(password);
    if (!validation.valid) {
      throw new Error(validation.message);
    }

    try {
      const salt = this._generateSecureRandom(this.CONSTANTS.SALT_LENGTH);
      const passwordHash = await this._deriveKey(password, salt, true);
      this.sessionKey = await this._deriveKey(password, salt, false);

      const authData = {
        passwordHash: this._toBase64(passwordHash),
        salt: this._toBase64(salt),
        version: '2.1',
        timestamp: Date.now()
      };

      if (!this._setStorageItem('ghostli_auth_data', authData)) {
        throw new Error('Failed to save authentication data');
      }

      if (window.electronAPI && window.electronAPI.dbSet) {
        await window.electronAPI.dbSet('ghostli_auth_data', JSON.stringify(authData));
      }

      this.isAuthenticated = true;
      return { success: true };
    } catch (e) {
      this._cleanup();
      throw e;
    }
  }

  async authenticate(password) {
    if (!password) {
      return { success: false, error: 'Password required' };
    }

    try {
      const authData = await this._loadAuthData();
      if (!authData) {
        return { success: false, error: 'No authentication data found' };
      }

      let salt, storedHash, iterations;

      if (authData.version === '2.1') {
        salt = this._fromBase64(authData.salt);
        storedHash = this._fromBase64(authData.passwordHash);
        iterations = this.CONSTANTS.PBKDF2_ITERATIONS;
      } else {
        try {
          salt = this._fromBase64(authData.salt);
          storedHash = this._fromBase64(authData.passwordHash);
          iterations = 150000;
        } catch (e) {
          console.error('Failed to parse legacy auth data:', e);
          return { success: false, error: 'Authentication data corrupted - please reset password' };
        }
      }

      const passwordHash = await this._deriveKeyLegacy(password, salt, iterations);

      if (!this._constantTimeCompare(passwordHash, storedHash)) {
        const delay = this.CONSTANTS.TIMING_ATTACK_DELAY + Math.random() * 100;
        await new Promise(resolve => setTimeout(resolve, delay));
        return { success: false, error: 'Invalid password' };
      }

      this.sessionKey = await this._deriveKey(password, salt, false);
      this.isAuthenticated = true;


      if (window.electronAPI && window.electronAPI.dbSet) {
        window.electronAPI.dbSet('ghostli_auth_data', JSON.stringify(authData)).catch(console.error);
      }

      return { success: true };
    } catch (e) {
      this._cleanup();
      return { success: false, error: 'Authentication failed: ' + e.message };
    }
  }

  async ensureAuthDataSynced() {
    const authData = this._getStorageItem('ghostli_auth_data');
    if (authData && window.electronAPI && window.electronAPI.dbSet) {
      await window.electronAPI.dbSet('ghostli_auth_data', JSON.stringify(authData));
    }
  }

  async storeEncryptedData(data) {
    if (!this.isAuthenticated || !this.sessionKey) {
      throw new Error('Not authenticated');
    }

    if (!data) throw new Error('No data provided');

    try {
      const encryptedPackage = await this._encrypt(data, this.sessionKey);


      if (window.electronAPI && window.electronAPI.dbSet) {
        const result = await window.electronAPI.dbSet('ghostli_encrypted_data', JSON.stringify(encryptedPackage));
        if (result && result.success === false) {
          throw new Error('Failed to save encrypted data to database: ' + result.error);
        }
      } else {

        if (!this._setStorageItem('ghostli_encrypted_data', encryptedPackage)) {
          throw new Error('Failed to save encrypted data');
        }
      }

      return { success: true };
    } catch (e) {
      this._cleanup();
      throw e;
    }
  }

  async getEncryptedData() {
    if (!this.isAuthenticated || !this.sessionKey) {
      throw new Error('Not authenticated');
    }

    try {
      let encryptedPackage = null;
      let usedSQLite = false;


      if (window.electronAPI && window.electronAPI.dbGet) {
        const result = await window.electronAPI.dbGet('ghostli_encrypted_data');
        if (result.success && result.value) {
          encryptedPackage = JSON.parse(result.value);
          usedSQLite = true;
        }
      }


      if (!encryptedPackage) {
        encryptedPackage = this._getStorageItem('ghostli_encrypted_data');


        if (encryptedPackage && window.electronAPI && window.electronAPI.dbSet) {
          console.log('Migrating data from localStorage to SQLite...');
          await window.electronAPI.dbSet('ghostli_encrypted_data', JSON.stringify(encryptedPackage));
          localStorage.removeItem('ghostli_encrypted_data');
          console.log('Migration complete.');
        }
      }

      if (!encryptedPackage) {
        return { success: true, data: {} };
      }

      const data = await this._decrypt(encryptedPackage, this.sessionKey);
      return { success: true, data };
    } catch (e) {
      this._cleanup();
      throw e;
    }
  }

  async migrateExistingData() {
    if (!this.isAuthenticated) throw new Error('Not authenticated');

    try {
      const existingData = {
        sessions: this._getStorageItem('ghostli_sessions') || {},
        currentSession: localStorage.getItem('ghostli_current_session'),
        globalSettings: this._getStorageItem('ghostli_global_settings') || {}
      };

      await this.storeEncryptedData(existingData);

      ['ghostli_sessions', 'ghostli_current_session', 'ghostli_global_settings']
        .forEach(key => localStorage.removeItem(key));

      return { success: true };
    } catch (e) {
      throw e;
    }
  }

  async clearAllData() {
    this._cleanup();
    this.sessionKey = null;
    this.isAuthenticated = false;

    ['ghostli_auth_data', 'ghostli_sessions',
      'ghostli_current_session', 'ghostli_global_settings']
      .forEach(key => localStorage.removeItem(key));

    if (window.electronAPI && window.electronAPI.dbDelete) {
      try {
        await Promise.all([
          window.electronAPI.dbDelete('ghostli_auth_data'),
          window.electronAPI.dbDelete('ghostli_encrypted_data')
        ]);
      } catch (error) {
        console.error('Failed to clear auth data from DB:', error);
      }
    }
    localStorage.removeItem('ghostli_encrypted_data');
  }

  logout() {
    this._cleanup();
    this.sessionKey = null;
    this.isAuthenticated = false;
  }

  isLoggedIn() {
    return this.isAuthenticated;
  }

  getSecurityStatus() {
    const cryptoCheck = this._checkCryptoSupport();
    return {
      cryptoSupported: cryptoCheck.supported,
      isAuthenticated: this.isAuthenticated,
      hasEncryptedData: !!localStorage.getItem('ghostli_encrypted_data'),
      version: '2.1',
      securityLevel: 'Enhanced'
    };
  }

  static checkCryptoSupport() {
    return new AuthManager()._checkCryptoSupport();
  }
}

try {
  window.authManager = new AuthManager();
} catch (e) {
  console.error('AuthManager initialization failed:', e.message);
  window.authManager = null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = AuthManager;
}