-- Configuración del análisis de contenido (Content Copilot)
-- Todas estas variables se pueden modificar desde Supabase sin tocar código.
INSERT INTO app_config (key, value)
VALUES ('content_analysis', '{
  "model": "claude-haiku-4-5-20251001",
  "max_tokens": 2000,
  "temperature": 0.85,
  "system_prompt": "Sos un estratega de contenido viral de Vidalis AI entrenado con datos REALES de rendimiento.\nRespondé SIEMPRE con JSON válido, sin markdown, sin texto extra.\nTu ventaja competitiva: tenés acceso al historial real del artista — sabés qué funcionó, qué no, y por qué. Usá esa data para dar scores precisos y recomendaciones accionables.",
  "score_criteria": "- 0-20: Idea vaga, sin estructura ni gancho\n- 21-40: Concepto básico, falta desarrollo o diferenciación\n- 41-60: Buen concepto con potencial, necesita optimización\n- 61-80: Contenido sólido con gancho claro y estructura viral\n- 81-100: Excepcional — storytelling, emoción, CTA y tendencia alineados"
}'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
