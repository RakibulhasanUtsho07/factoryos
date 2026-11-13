type ClassToken = string | false | null | undefined;

export function cx(...tokens: ClassToken[]): string {
  return tokens.filter((token): token is string => typeof token === "string" && token.length > 0).join(" ");
}
