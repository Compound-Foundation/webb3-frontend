// A one-day TLS certificate for 127.0.0.1, made with the `openssl` CLI, so that the app's `https://` RPC URLs
// can point at the harness without a new dependency. The key stays in the run's private directory.
import { spawnSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';

export type Certificate = {
  key: Buffer;
  cert: Buffer;
  certPath: string;
  /** The base64 SHA-256 of the certificate's public key, recorded in the manifest to identify the certificate. */
  spkiHash: string;
};

const CONFIG = `[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = 127.0.0.1
[ext]
subjectAltName = IP:127.0.0.1
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = serverAuth
`;

/** Makes an EC P-256 key and a self-signed certificate for 127.0.0.1 in `directory`. */
export function makeCertificate(directory: string): Certificate {
  const configPath = path.join(directory, 'openssl.cnf');
  const keyPath = path.join(directory, 'tls-key.pem');
  const certPath = path.join(directory, 'tls-cert.pem');
  fs.writeFileSync(configPath, CONFIG, { mode: 0o600 });
  const result = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:P-256',
      '-nodes',
      '-days',
      '1',
      '-config',
      configPath,
      '-keyout',
      keyPath,
      '-out',
      certPath,
    ],
    { encoding: 'utf8' }
  );
  if (result.status !== 0) throw new Error(`openssl could not make the harness certificate: ${result.stderr}`);
  fs.chmodSync(keyPath, 0o600);
  const cert = fs.readFileSync(certPath);
  const spki = new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' });
  return {
    key: fs.readFileSync(keyPath),
    cert,
    certPath,
    spkiHash: createHash('sha256').update(spki).digest('base64'),
  };
}

type TlsDefaults = {
  getCACertificates: (type: 'default') => string[];
  setDefaultCACertificates: (certificates: string[]) => void;
};

/**
 * Adds the harness certificate to this Node process's default trusted certificates, beside the system's,
 * so that the browser egress route (`egress.ts`), which fetches the browser's requests in Node, can reach the
 * HTTPS RPC proxy. It trusts that one certificate for 127.0.0.1, and disables no verification.
 */
export function trustHarnessCertificate(certificatePem: string): void {
  const defaults = tls as unknown as TlsDefaults;
  const current = defaults.getCACertificates('default');
  if (!current.includes(certificatePem)) defaults.setDefaultCACertificates([...current, certificatePem]);
}
