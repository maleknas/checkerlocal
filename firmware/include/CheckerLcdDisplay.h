#pragma once

#include <Arduino.h>

#include "CheckerV2Config.h"

#ifndef CHECKER_LCD_ENABLED
#define CHECKER_LCD_ENABLED 1
#endif

#ifndef CHECKER_LCD_RS_PIN
#define CHECKER_LCD_RS_PIN 21
#endif

#ifndef CHECKER_LCD_ENABLE_PIN
#define CHECKER_LCD_ENABLE_PIN 33
#endif

#ifndef CHECKER_LCD_DB4_PIN
#define CHECKER_LCD_DB4_PIN 4
#endif

#ifndef CHECKER_LCD_DB5_PIN
#define CHECKER_LCD_DB5_PIN 14
#endif

#ifndef CHECKER_LCD_DB6_PIN
#define CHECKER_LCD_DB6_PIN 13
#endif

#ifndef CHECKER_LCD_DB7_PIN
#define CHECKER_LCD_DB7_PIN 32
#endif

void checkerLcdBegin();
void checkerLcdShowResult(const String &result);
void checkerLcdUpdate(const char *modeName, bool readerReady, bool serverReady, const String &readerStatus, const String &assignName);
