// SEP-1 binding: stellar.toml names the registry (RECON_REGISTRY="C..."), and
// the registry names the anchor's home_domain. Unknown top-level keys must be
// ignored by SEP-1 parsers (verify-first item (b)); the fallback is a URL
// under [DOCUMENTATION] (ORG_RECON_REGISTRY).

export interface TomlBinding {
  registry?: string;
  source: 'top-level' | 'documentation' | 'none';
}

export function parseRegistryFromToml(toml: string): TomlBinding {
  let section = '';
  let doc: string | undefined;
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const sec = /^\[+([^\]]+)\]+$/.exec(line);
    if (sec) {
      section = sec[1].trim();
      continue;
    }
    const kv = /^([A-Za-z0-9_]+)\s*=\s*"([^"]*)"$/.exec(line);
    if (!kv) continue;
    if (section === '' && kv[1] === 'RECON_REGISTRY') return { registry: kv[2], source: 'top-level' };
    if (section === 'DOCUMENTATION' && kv[1] === 'ORG_RECON_REGISTRY') doc = kv[2].split('/').pop();
  }
  return doc ? { registry: doc, source: 'documentation' } : { source: 'none' };
}

export function verifyTomlBinding(toml: string, registryId: string, registryHomeDomain: string, tomlDomain: string): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const b = parseRegistryFromToml(toml);
  if (!b.registry) errors.push('stellar.toml has no RECON_REGISTRY');
  else if (b.registry !== registryId) errors.push(`stellar.toml names ${b.registry}, expected ${registryId}`);
  if (registryHomeDomain.toLowerCase() !== tomlDomain.toLowerCase()) errors.push(`registry home_domain ${registryHomeDomain} != ${tomlDomain}`);
  return { ok: errors.length === 0, errors };
}
