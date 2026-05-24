use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use serde_json::Value;
use crate::errors::{ShellError, ShellResult};
use crate::tasks::TaskInternalPersistent;

pub struct Storage {
    pub app_data_dir: PathBuf,
    settings_file: PathBuf,
    tasks_file: PathBuf,
    settings: Mutex<HashMap<String, Value>>,
    tasks: Mutex<HashMap<String, TaskInternalPersistent>>,
}

impl Storage {
    pub fn new(app_data_dir: PathBuf) -> Self {
        fs::create_dir_all(&app_data_dir).unwrap_or_default();
        let settings_file = app_data_dir.join("settings.json");
        let tasks_file = app_data_dir.join("tasks.json");

        let settings = if settings_file.exists() {
            let content = fs::read_to_string(&settings_file).unwrap_or_default();
            serde_json::from_str(&content).unwrap_or_default()
        } else {
            HashMap::new()
        };

        let tasks = if tasks_file.exists() {
            let content = fs::read_to_string(&tasks_file).unwrap_or_default();
            serde_json::from_str(&content).unwrap_or_default()
        } else {
            HashMap::new()
        };

        Storage {
            app_data_dir,
            settings_file,
            tasks_file,
            settings: Mutex::new(settings),
            tasks: Mutex::new(tasks),
        }
    }

    pub fn read_setting(&self, key: &str) -> ShellResult<Option<Value>> {
        let settings = self.settings.lock().map_err(|e| ShellError::StorageError {
            message: e.to_string(),
        })?;
        Ok(settings.get(key).cloned())
    }

    pub fn write_setting(&self, key: String, value: Value) -> ShellResult<()> {
        let mut settings = self.settings.lock().map_err(|e| ShellError::StorageError {
            message: e.to_string(),
        })?;
        settings.insert(key, value);
        let serialized = serde_json::to_string_pretty(&*settings)
            .map_err(|e| ShellError::StorageError { message: e.to_string() })?;
        fs::write(&self.settings_file, serialized)?;
        Ok(())
    }

    pub fn delete_setting(&self, key: &str) -> ShellResult<()> {
        let mut settings = self.settings.lock().map_err(|e| ShellError::StorageError {
            message: e.to_string(),
        })?;
        settings.remove(key);
        let serialized = serde_json::to_string_pretty(&*settings)
            .map_err(|e| ShellError::StorageError { message: e.to_string() })?;
        fs::write(&self.settings_file, serialized)?;
        Ok(())
    }

    pub fn save_task(&self, task: TaskInternalPersistent) -> ShellResult<()> {
        let mut tasks = self.tasks.lock().map_err(|e| ShellError::StorageError {
            message: e.to_string(),
        })?;
        tasks.insert(task.state.id.clone(), task);
        let serialized = serde_json::to_string_pretty(&*tasks)
            .map_err(|e| ShellError::StorageError { message: e.to_string() })?;
        fs::write(&self.tasks_file, serialized)?;
        Ok(())
    }

    pub fn get_task(&self, id: &str) -> ShellResult<Option<TaskInternalPersistent>> {
        let tasks = self.tasks.lock().map_err(|e| ShellError::StorageError {
            message: e.to_string(),
        })?;
        Ok(tasks.get(id).cloned())
    }

    pub fn list_tasks(&self) -> ShellResult<Vec<TaskInternalPersistent>> {
        let tasks = self.tasks.lock().map_err(|e| ShellError::StorageError {
            message: e.to_string(),
        })?;
        let mut vec: Vec<TaskInternalPersistent> = tasks.values().cloned().collect();
        vec.sort_by(|a, b| b.state.created_at.cmp(&a.state.created_at));
        Ok(vec)
    }
}

// -------------------------------------------------------------------
// Simple Hex-XOR Secure obfuscation layer (Developer mode fallback)
// -------------------------------------------------------------------

const XOR_KEY: &[u8] = b"KARO_DEV_KEY_OBFUSCATION_SALT_12345";

pub fn encrypt_secret_obfuscated(secret: &str) -> ShellResult<crate::EncryptedBlob> {
    let bytes = secret.as_bytes();
    let mut obfuscated = Vec::with_capacity(bytes.len());
    for (i, &b) in bytes.iter().enumerate() {
        let key_byte = XOR_KEY[i % XOR_KEY.len()];
        obfuscated.push(b ^ key_byte);
    }
    let hex_cipher = hex_encode(&obfuscated);
    Ok(crate::EncryptedBlob {
        algorithm: "developer-xor-obfuscated.v1".to_string(),
        ciphertext: hex_cipher,
        created_at: "2026-05-22T09:30:00Z".to_string(),
    })
}

pub fn decrypt_secret_obfuscated(blob: crate::EncryptedBlob) -> ShellResult<String> {
    if blob.algorithm != "developer-xor-obfuscated.v1" {
        return Err(ShellError::PermissionDenied {
            message: format!("Unsupported decryption algorithm '{}'", blob.algorithm),
        });
    }
    let bytes = hex_decode(&blob.ciphertext).map_err(|e| ShellError::PermissionDenied {
        message: format!("Failed to decode hex payload: {}", e),
    })?;
    let mut plain_bytes = Vec::with_capacity(bytes.len());
    for (i, &b) in bytes.iter().enumerate() {
        let key_byte = XOR_KEY[i % XOR_KEY.len()];
        plain_bytes.push(b ^ key_byte);
    }
    String::from_utf8(plain_bytes).map_err(|e| ShellError::PermissionDenied {
        message: format!("Obfuscated payload is not valid UTF-8: {}", e),
    })
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

fn hex_decode(hex: &str) -> Result<Vec<u8>, String> {
    if hex.len() % 2 != 0 {
        return Err("Invalid hex length".to_string());
    }
    let mut bytes = Vec::new();
    let chars: Vec<char> = hex.chars().collect();
    for i in (0..hex.len()).step_by(2) {
        let pair = format!("{}{}", chars[i], chars[i+1]);
        let byte = u8::from_str_radix(&pair, 16).map_err(|e| e.to_string())?;
        bytes.push(byte);
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_secret_obfuscation() {
        let original = "my-super-secret-api-key-12345";
        let encrypted = encrypt_secret_obfuscated(original).unwrap();
        assert_eq!(encrypted.algorithm, "developer-xor-obfuscated.v1");
        assert_ne!(encrypted.ciphertext, original);

        let decrypted = decrypt_secret_obfuscated(encrypted).unwrap();
        assert_eq!(decrypted, original);
    }
}
