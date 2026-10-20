#pragma once

// Copy this file to CheckerV2Config.h and fill in local values.
// Do not commit real hotspot credentials.
#define CHECKER_WIFI_SSID "Your-Mobile-Hotspot-SSID"
#define CHECKER_WIFI_PASSWORD "Your-Mobile-Hotspot-Password"

// Use the PC Mobile Hotspot IPv4 address. Windows normally gives the PC hotspot 192.168.137.1.
// Do not use localhost here; localhost would be the ESP32 itself.
#define CHECKER_SERVER_WS_URL "ws://192.168.137.1:8080/device"

#define CHECKER_RC522_SS_PIN 5
#define CHECKER_RC522_RST_PIN 22
#define CHECKER_SPI_SCK_PIN 18
#define CHECKER_SPI_MISO_PIN 19
#define CHECKER_SPI_MOSI_PIN 23

#define CHECKER_GREEN_LED_PIN 26
#define CHECKER_RED_LED_PIN 27
#define CHECKER_BUZZER_PIN 25

#define CHECKER_LED_ACTIVE_HIGH 1
#define CHECKER_BUZZER_ACTIVE_HIGH 1

// Set to 0 to build without the optional 16x2 parallel LCD keypad shield.
#define CHECKER_LCD_ENABLED 1
#define CHECKER_LCD_RS_PIN 21
#define CHECKER_LCD_ENABLE_PIN 33
#define CHECKER_LCD_DB4_PIN 4
#define CHECKER_LCD_DB5_PIN 14
#define CHECKER_LCD_DB6_PIN 13
#define CHECKER_LCD_DB7_PIN 32
