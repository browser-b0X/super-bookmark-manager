export const wrap = children => JSON.stringify({roots:{bookmark_bar:{type:'folder',children}}});
export const node = (url, name='Synthetic') => ({type:'url',url,name});
export const malformed = [
  ['empty',''], ['invalid-json','{'], ['null','null'], ['empty-object','{}'],
  ['missing-roots','{"bookmarks":[]}'], ['roots-array','{"roots":[]}'],
  ['bad-children',wrap([{type:'folder',children:{}}])],
  ['missing-url',wrap([{type:'url',name:'Missing'}])],
  ['unsupported-only',wrap([node('javascript:alert(1)')])],
  ['null-child',wrap([null])], ['bad-url',wrap([node('https://')])],
  ['partial-invalid',wrap([node('https://native.example.invalid/must-not-import'),{type:'url'}])],
  ['bad-name',wrap([{type:'url',url:'https://example.invalid',name:42}])],
  ['empty-folders',wrap([])], ['unknown-node',wrap([{type:'unknown'}])],
];
