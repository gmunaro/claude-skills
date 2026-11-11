---
# Design tokens that agents use when generating UI. Structure based on t3dotgg/ui-design-bench/DESIGN.md.
# The project's real values; names by role (ink, surface, accent), not by color.
name: <product name>
description: <one sentence about the look>
colors:
  canvas: "#..."
  surface: "#..."
  ink: "#..."
  body: "#..."
  muted: "#..."
  divider: "#..."
  accent: "#..."
  accent-foreground: "#..."
  positive: "#..."
  error: "#..."
typography:
  display: { fontFamily: "...", fontSize: "...", fontWeight: 500, lineHeight: 1.1 }
  title: { fontFamily: "...", fontSize: "...", fontWeight: 500, lineHeight: 1.3 }
  body: { fontFamily: "...", fontSize: "...", fontWeight: 400, lineHeight: 1.6 }
  label: { fontFamily: "...", fontSize: "...", fontWeight: 500, lineHeight: 1.4 }
rounded: { sm: "4px", md: "6px", lg: "8px", full: "9999px" }
spacing: { xs: "4px", sm: "8px", md: "16px", lg: "24px", xl: "32px" }
components:
  button-primary: { backgroundColor: "{colors.accent}", textColor: "{colors.accent-foreground}", rounded: "{rounded.lg}" }
---

# Design system: <name>

## 1. Overview
<!-- 3 to 5 lines: the overall feel and the layout decision that defines the product. -->

## 2. Colors
<!-- Primary, neutral and state colors: where each one appears. "Named rules": for example, "the accent appears at most once per screen". -->

## 3. Typography
<!-- Hierarchy (which style for which element) and named rules. -->

## 4. Elevation
<!-- Shadow and border vocabulary; when to use each one. -->

## 5. Components
<!-- Buttons, cards, inputs, navigation, and the product's signature component, with states. -->

## 6. Do and don't
<!-- Short, checkable lists. The "don't" list names the AI-generated-UI habits this product avoids (generic gradient, grid of identical cards, etc.). -->
