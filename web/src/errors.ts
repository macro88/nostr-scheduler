export type PlainError = {
  message: string;
  detail: string;
};

export function plainError(error: unknown): PlainError {
  const detail = error instanceof Error ? error.message : "The request failed.";
  const text = detail.toLowerCase();
  if (text.includes("past") || text.includes("already passed")) {
    return { message: "That time has already passed. Choose a later time.", detail };
  }
  if (text.includes("horizon") || text.includes("further ahead") || text.includes("7 day")) {
    return { message: "This time is further ahead than you can sign. Choose a time within 7 days.", detail };
  }
  if (text.includes("frozen") || text.includes("discard it")) {
    return { message: "This event is signed, so the time is frozen. Discard it and sign again.", detail };
  }
  if (text.includes("browser signer") || text.includes("signer did not") || text.includes("no browser signer")) {
    return { message: "The signer did not respond. Try again, or use a bunker.", detail };
  }
  if (text.includes("bunker")) {
    return { message: "This bunker link is not valid. Check it and try again.", detail };
  }
  if (text.includes("relay") || text.includes("timeout")) {
    return { message: "The relay did not accept the note. Try publishing again.", detail };
  }
  if (text.includes("could not be loaded")) {
    return { message: detail.includes("Try again") ? detail : "The log could not be loaded. Try again.", detail };
  }
  if (text.includes("log")) {
    return { message: "The log could not be loaded. Try again.", detail };
  }
  if (text.includes("too small") || text.includes("expected") || text.includes("invalid")) {
    return { message: "Check the text and the time, then try again.", detail };
  }
  return { message: "That change could not be saved. Try again.", detail };
}
