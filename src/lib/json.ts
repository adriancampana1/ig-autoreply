/** Meta pode mandar IDs (id, user_id, comment_id, parent_id) como número JSON acima de 2^53, que o JSON.parse corromperia: vira string antes do parse. */
export function quoteLargeIds(text: string): string {
  return text.replace(/"(id|user_id|comment_id|parent_id)"\s*:\s*(-?\d+)(?![\d.eE])/g, '"$1":"$2"');
}
