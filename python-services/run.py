import os
import uvicorn

# Cargar automáticamente las variables del .env principal del proyecto
env_path = os.path.join(os.path.dirname(__file__), "..", ".env")
if os.path.exists(env_path):
    print("🔋 Cargando variables desde el archivo .env principal...")
    with open(env_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, val = line.split("=", 1)
                val = val.strip('"').strip("'")
                os.environ[key] = val

if __name__ == "__main__":
    # RELOAD apagado por defecto. En Windows, el watcher de reload vigila TODO
    # el árbol (incluidos .venv con miles de archivos y static/ donde caen los
    # videos subidos); durante subidas grandes agota los búferes de socket del
    # sistema -> WinError 10055 -> el servidor se cae y la siguiente subida se
    # queda colgada. Solo activa reload (DEV_RELOAD=1) cuando estés editando
    # main.py y NO vayas a subir videos.
    reload_enabled = os.environ.get("DEV_RELOAD", "0") == "1"
    modo = "con reload (dev)" if reload_enabled else "estable (sin reload)"
    print(f"🚀 Iniciando microservicio de Python en http://localhost:8080 [{modo}]")
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8080,
        reload=reload_enabled,
        reload_excludes=[".venv/*", "static/*", "__pycache__/*", "*.pyc"],
    )
