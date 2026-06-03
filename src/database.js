const sqlite3 = require('sqlite3');
const path = require('path');
const { app } = require('electron');

class DatabaseManager {
    constructor() {
        this.db = null;
        this.dbPath = path.join(app.getPath('userData'), 'ghostli.db');
    }

    initialize() {
        return new Promise((resolve, reject) => {
            this.db = new sqlite3.Database(this.dbPath, (err) => {
                if (err) {
                    console.error('Could not connect to database', err);
                    reject(err);
                } else {
                    console.log('Connected to SQLite database at', this.dbPath);
                    this._createTables().then(resolve).catch(reject);
                }
            });
        });
    }

    _createTables() {
        return new Promise((resolve, reject) => {
            const sql = `
        CREATE TABLE IF NOT EXISTS kv_store (
          key TEXT PRIMARY KEY,
          value TEXT
        );
      `;
            this.db.run(sql, (err) => {
                if (err) {
                    console.error('Could not create tables', err);
                    reject(err);
                } else {
                    console.log('Tables initialized');
                    resolve();
                }
            });
        });
    }

    get(key) {
        return new Promise((resolve, reject) => {
            this.db.get('SELECT value FROM kv_store WHERE key = ?', [key], (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row ? row.value : null);
                }
            });
        });
    }

    set(key, value) {
        return new Promise((resolve, reject) => {
            this.db.run('INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)', [key, value], (err) => {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }

    delete(key) {
        return new Promise((resolve, reject) => {
            this.db.run('DELETE FROM kv_store WHERE key = ?', [key], (err) => {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }

    getEncrypted(key) {
        const { safeStorage } = require('electron');
        return new Promise(async (resolve, reject) => {
            try {
                const encryptedBase64 = await this.get(key);
                if (!encryptedBase64) {
                    resolve(null);
                    return;
                }

                if (safeStorage.isEncryptionAvailable()) {
                    const encryptedBuffer = Buffer.from(encryptedBase64, 'base64');
                    const decryptedBuffer = safeStorage.decryptString(encryptedBuffer);
                    resolve(decryptedBuffer);
                } else {
        
                    console.warn('Encryption not available, returning null');
                    resolve(null);
                }
            } catch (error) {
                console.error('Error decrypting value:', error);
                resolve(null);
            }
        });
    }

    setEncrypted(key, value) {
        const { safeStorage } = require('electron');
        return new Promise(async (resolve, reject) => {
            try {
                if (safeStorage.isEncryptionAvailable()) {
                    const encryptedBuffer = safeStorage.encryptString(value); // value must be string
                    const encryptedBase64 = encryptedBuffer.toString('base64');
                    await this.set(key, encryptedBase64);
                    resolve();
                } else {
                    reject(new Error('Encryption is not available on this system'));
                }
            } catch (error) {
                reject(error);
            }
        });
    }

    close() {
        return new Promise((resolve, reject) => {
            if (this.db) {
                this.db.close((err) => {
                    if (err) {
                        console.error('Error closing database:', err);
                        reject(err);
                    } else {
                        console.log('Database connection closed');
                        resolve();
                    }
                });
            } else {
                resolve();
            }
        });
    }
}

module.exports = DatabaseManager;
