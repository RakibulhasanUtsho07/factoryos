export function cx(...tokens) {
  return tokens
    .filter((token) => typeof token === "string" && token.length > 0)
    .join(" ");
}
