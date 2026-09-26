export function orderedByIds(items, ids, getId) {
  const ranks = new Map(ids.map((id, index) => [id, index]));
  return items.map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const aRank = ranks.get(getId(a.item));
      const bRank = ranks.get(getId(b.item));
      if (aRank === undefined && bRank === undefined) return a.index - b.index;
      if (aRank === undefined) return 1;
      if (bRank === undefined) return -1;
      return aRank - bRank;
    }).map(({ item }) => item);
}

export function moveId(ids, id, targetId, after = false) {
  const next = ids.filter((value) => value !== id);
  const targetIndex = next.indexOf(targetId);
  if (targetIndex < 0) return [...next, id];
  next.splice(targetIndex + (after ? 1 : 0), 0, id);
  return next;
}

export function moveIdBy(ids, id, offset) {
  const index = ids.indexOf(id);
  if (index < 0) return ids;
  const target = Math.max(0, Math.min(ids.length - 1, index + offset));
  if (target === index) return ids;
  const next = [...ids];
  next.splice(index, 1);
  next.splice(target, 0, id);
  return next;
}
