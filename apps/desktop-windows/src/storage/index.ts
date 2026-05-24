/**
 * Public surface of the Local Encrypted Storage abstraction.
 *
 * Validates: Requirements 1.6, 2.5, 4.5.
 */

export type {
  KeyMaterialProvider,
  LocalKvStore,
  SecretCipher,
} from "./types.js";

export {
  AES_256_GCM_ALGORITHM,
  AES_256_KEY_LENGTH,
  AES_GCM_IV_LENGTH,
  AesGcmSecretCipher,
} from "./secretCipher.js";

export {
  InMemoryKeyMaterialProvider,
  RandomInMemoryKeyMaterialProvider,
} from "./keyProvider.js";

export {
  InMemoryLocalKvStore,
  JsonFileLocalKvStore,
} from "./localKvStore.js";

export {
  BrowserLocalStorageKvStore,
  type BrowserLocalStorageKvStoreOptions,
  type WebStorageLike,
} from "./browserLocalStorageKvStore.js";

export {
  ENCRYPTED_SETTING_PREFIX,
  LocalEncryptedStorage,
  createInMemoryEncryptedStorage,
  createInvokeForLocalStorage,
  isEncryptedBlob,
} from "./localStorageBackend.js";
export type {
  InvokeAdapterOptions,
  InvokeFn,
  LocalEncryptedStorageOptions,
} from "./localStorageBackend.js";
