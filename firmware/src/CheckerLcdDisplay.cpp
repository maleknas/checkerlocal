#include "CheckerLcdDisplay.h"

#if CHECKER_LCD_ENABLED
#include <Wire.h>
#include <hd44780.h>
#include <hd44780ioClass/hd44780_I2Cexp.h>

static const uint8_t LCD_COLS = 16;
static const uint32_t LCD_TEMP_MESSAGE_MS = 2000;

hd44780_I2Cexp lcd;

String lcdLine1;
String lcdLine2;
String lcdTempLine1;
String lcdTempLine2;
uint32_t lcdTempUntilMs = 0;

String printableText(const String &text) {
  String out;
  out.reserve(text.length());
  bool lastWasSpace = false;
  for (size_t i = 0; i < text.length(); i++) {
    char c = text.charAt(i);
    if (c < 32 || c > 126) c = '?';
    if (c == ' ') {
      if (lastWasSpace) continue;
      lastWasSpace = true;
    } else {
      lastWasSpace = false;
    }
    out += c;
  }
  out.trim();
  return out;
}

String lcdLineText(const String &text) {
  String clean = printableText(text);
  String out;
  out.reserve(LCD_COLS);
  for (size_t i = 0; i < clean.length() && out.length() < LCD_COLS; i++) {
    out += clean.charAt(i);
  }
  while (out.length() < LCD_COLS) out += ' ';
  return out;
}

void wrapText(const String &text, String &line1, String &line2) {
  String clean = printableText(text);
  if (clean.length() <= LCD_COLS) {
    line1 = clean;
    line2 = "";
    return;
  }

  int breakAt = -1;
  for (uint8_t i = 0; i <= LCD_COLS && i < clean.length(); i++) {
    if (clean.charAt(i) == ' ') breakAt = i;
  }
  if (breakAt <= 0) breakAt = LCD_COLS;

  line1 = clean.substring(0, breakAt);
  line1.trim();
  line2 = clean.substring(breakAt);
  line2.trim();
}

void writeLcdLines(const String &line1, const String &line2) {
  String nextLine1 = lcdLineText(line1);
  String nextLine2 = lcdLineText(line2);
  if (nextLine1 == lcdLine1 && nextLine2 == lcdLine2) return;
  lcd.setCursor(0, 0);
  lcd.print(nextLine1);
  lcd.setCursor(0, 1);
  lcd.print(nextLine2);
  lcdLine1 = nextLine1;
  lcdLine2 = nextLine2;
}

String friendlyModeName(const char *modeName) {
  String mode = modeName ? String(modeName) : String("IDLE");
  if (mode == "CHECK_IN") return "Check in";
  if (mode == "ASSIGN_SINGLE") return "Assign single";
  if (mode == "ASSIGN_FAST") return "Assign fast";
  return "Checker paused";
}

void splitResult(const String &result, String &line1, String &line2) {
  String text = result;
  text.trim();
  if (!text.length()) {
    line1 = "Result";
    line2 = "";
    return;
  }

  int separator = text.indexOf(" - ");
  if (separator > 0) {
    line1 = text.substring(0, separator);
    line2 = text.substring(separator + 3);
    return;
  }

  wrapText(text, line1, line2);
}
#endif

void checkerLcdBegin() {
#if CHECKER_LCD_ENABLED
  Wire.begin(21, 33, 100000);
  lcd.begin(16, 2);
  lcd.backlight();
  writeLcdLines("Checker", "Starting...");
#endif
}

void checkerLcdShowResult(const String &result) {
#if CHECKER_LCD_ENABLED
  splitResult(result, lcdTempLine1, lcdTempLine2);
  lcdTempUntilMs = millis() + LCD_TEMP_MESSAGE_MS;
  writeLcdLines(lcdTempLine1, lcdTempLine2);
#else
  (void)result;
#endif
}

void checkerLcdUpdate(const char *modeName, bool readerReady, bool serverReady, const String &readerStatus, const String &assignName) {
#if CHECKER_LCD_ENABLED
  if (lcdTempUntilMs && millis() < lcdTempUntilMs) return;
  lcdTempUntilMs = 0;

  String rawMode = modeName ? String(modeName) : String("IDLE");
  String line1 = friendlyModeName(modeName);
  String line2 = "";
  if (line1 != "Checker paused") {
    if (!readerReady) {
      line1 = "Reader fault";
      line2 = readerStatus.length() ? readerStatus : String("Manual check-in");
    } else if (!serverReady) {
      line1 = "Server not ready";
      line2 = "Waiting...";
    } else if (rawMode == "ASSIGN_SINGLE" || rawMode == "ASSIGN_FAST") {
      line1 = "Assign card to:";
      line2 = assignName.length() ? assignName : String("Waiting for name");
    } else {
      line2 = "Scan your card";
    }
  }
  writeLcdLines(line1, line2);
#else
  (void)modeName;
  (void)readerReady;
  (void)serverReady;
  (void)readerStatus;
  (void)assignName;
#endif
}
