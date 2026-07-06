// Cache en memoria con TTL, pensado solo para catálogos que cambian con poca
// frecuencia (perfiles de acceso, permisos por cargo, etc.). No usar para datos
// sensibles a frescura como estados de envío o información cargada por productores.
const store = new Map();

const getOrSet = async (key, ttlMs, loader) => {
  const cached = store.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const value = await loader();
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
};

const invalidate = (key) => {
  if (key) {
    store.delete(key);
  } else {
    store.clear();
  }
};

module.exports = { getOrSet, invalidate };
