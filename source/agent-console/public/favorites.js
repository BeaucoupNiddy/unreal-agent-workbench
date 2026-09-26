export function applyModelFavorites(configOptions, favorites = []) {
  const model = (configOptions || []).find((option) => option.id === "model");
  if (!model || !Array.isArray(model.options)) return configOptions;
  const favoriteSet = new Set(favorites);
  const rank = (option) => favoriteSet.has(option.value) ? 0 : option.recommended ? 1 : 2;
  model.options = model.options.map((option, index) => {
    const favorite = favoriteSet.has(option.value);
    const { favorite: _favorite, ...base } = option;
    return {
      ...base,
      name: `${favorite ? "★ " : ""}${String(option.name || option.value).replace(/^★\s+/, "")}`,
      ...(favorite ? { favorite: true } : {}),
      _favoriteOrder: index
    };
  }).sort((a, b) => rank(a) - rank(b) || a._favoriteOrder - b._favoriteOrder)
    .map(({ _favoriteOrder, ...option }) => option);
  return configOptions;
}
