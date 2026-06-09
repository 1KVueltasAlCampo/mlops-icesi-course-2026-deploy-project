# LexScribe Jurídico - Whisper ONNX Deploy Project

## Propósito del Sistema y Caso de Uso

En la actualidad, la falta de herramientas de transcripción eficientes genera una enorme pérdida de tiempo al momento de analizar reuniones, consultas o entrevistas. Este proyecto nace para solucionar ese problema mediante un sistema automatizado de transcripción de voz a texto. 

Aunque en este caso se presenta bajo el contexto de **"LexScribe Jurídico"** (una herramienta pensada para transcribir consultas legales, audiencias y dictámenes), la arquitectura es completamente agnóstica y **puede aplicarse a cualquier otro dominio**, como la medicina, el servicio al cliente, la academia o el periodismo.

El objetivo técnico de este sistema es exponer una API utilizando FastAPI que reciba archivos de audio `.wav` y retorne la transcripción generada por un modelo `whisper-base` pre-entrenado en formato ONNX. Adicionalmente, cuenta con un flujo CI/CD automatizado que valida la calidad y latencia del modelo, para luego desplegar la aplicación final en una instancia EC2 de AWS usando contenedores Docker de forma automática.

## Arquitectura General de la Solución

La solución implementa una arquitectura MLOps completa para el despliegue automatizado de un modelo Whisper ONNX utilizando AWS y GitHub Actions.

### Flujo de Predicción

Usuario
→ Interfaz Web / API FastAPI
→ Modelo Whisper ONNX (descargado dinámicamente desde Amazon S3)
→ Generación de Transcripción
→ Respuesta al Usuario
→ Registro de Predicción en Amazon S3

### Flujo de CI/CD

Push a rama dev o prod
→ GitHub Actions
→ Descarga del modelo ONNX desde Amazon S3
→ Descarga de datos de prueba desde Amazon S3
→ Ejecución de pruebas automáticas (Inferencia, Latencia y WER)
→ Construcción de imagen Docker
→ Publicación en Amazon ECR
→ Despliegue automático en Amazon EC2
→ Actualización del endpoint correspondiente

### Componentes Principales

- GitHub: Control de versiones y gestión de ramas.
- GitHub Actions: Automatización de pruebas y despliegues.
- Amazon S3: Almacenamiento del modelo ONNX, datos de prueba y logs de predicciones.
- FastAPI: Exposición del endpoint de inferencia.
- Docker: Empaquetamiento de la aplicación.
- Amazon ECR: Registro de imágenes de contenedores.
- Amazon EC2: Hospedaje de los entornos dev y prod.
- Whisper ONNX: Motor de transcripción de voz a texto.


## Estructura del Repositorio

- **`app.py`**: Servidor FastAPI. Contiene el endpoint `/predict` y la lógica para descargar el modelo de S3 al arrancar, además de guardar logs de transcripción en S3.
- **`test_model.py`**: Suite de pruebas (pytest) para validación en integración continua.
- **`Dockerfile`**: Definición de la imagen de Docker para la API, incluyendo dependencias del sistema operativo para procesamiento de audio.
- **`.github/workflows/deploy.yml`**: Flujo de CI/CD que se activa automáticamente en las ramas `dev` y `prod`.
- **`.env.example`**: Archivo de ejemplo para configuración de variables de entorno.
- **`static/`**: Interfaz web premium para grabar audio en vivo o subir archivos.

### Ramas y Entornos
- `dev`: Entorno de desarrollo. Expuesto en el puerto 8001.
- `prod`: Entorno de producción. Expuesto en el puerto 8000.

## Flujo de CI/CD (GitHub Actions)

El sistema utiliza **GitHub Actions** para garantizar que los despliegues sean seguros y automáticos. Cada vez que se hace un `push` a las ramas `dev` o `prod`, el pipeline se preocupa por ejecutar dos etapas principales:

1. **Etapa de `test`**:
   - Descarga dinámicamente el modelo ONNX desde el bucket S3 (el modelo no vive en el repositorio por buenas prácticas, se obtiene en tiempo de CI/CD).
   - Descarga los datos de prueba (`sample.wav` y `wer_reference.csv`) desde S3.
   - Ejecuta validaciones estrictas (Inferencia, Latencia y Tasa de Error) para asegurar que el modelo funciona y cumple con la calidad requerida.

2. **Etapa de `build_and_promote`**:
   - Se ejecuta **solo si la etapa de test fue exitosa**.
   - Construye el contenedor de Docker (`Dockerfile`) empaquetando la aplicación web y la API. El contenedor descarga el modelo de S3 al iniciar para que la imagen final sea ligera.
   - Sube la imagen del contenedor a la solución final: **Amazon ECR**.
   - Se conecta por SSH a la instancia **Amazon EC2**, detiene la versión anterior, descarga la versión nueva y actualiza el endpoint automáticamente.

## Pruebas y Métricas de Calidad

El pipeline ejecuta pruebas automatizadas utilizando los datos descargados de S3.

1. **Verificación de Inferencia y Latencia**: Chequea que el modelo produzca resultados sin errores y en menos de 5.0 segundos usando un audio de prueba simple (`sample.wav`), cuyo contenido esperado es:
   > *"Uno, dos, tres, probando el sistema de voz"*

2. **Word Error Rate (WER)**: Se calcula la tasa de error comparando las predicciones del modelo contra transcripciones maestras. Si el WER promedio es superior a 0.5, el despliegue falla garantizando no hacer regresiones de calidad. Para esto, se utiliza el archivo `test_data/wer_reference.csv` que contiene las siguientes referencias exactas:
   ```csv
   filename,reference
   audio1.wav,el gato duerme sobre la silla roja
   audio2.wav,mañana vamos a caminar por el parque
   audio3.wav,el cielo está despejado y hace mucho calor
   audio4.wav,cierra la puerta antes de salir de casa
   audio5.wav,tengo una reunión a las tres de la tarde
   ```
   *El pipeline evalúa el modelo contra estos 5 audios que también se encuentran alojados en el bucket.*

## Configuración de Secretos y AWS

Para que el sistema funcione en local y en el pipeline, debes definir los siguientes secretos en **Settings > Secrets and variables > Actions** de tu repositorio:

- `AWS_ACCESS_KEY_ID`: Credencial de AWS.
- `AWS_SECRET_ACCESS_KEY`: Clave secreta de AWS.
- `AWS_REGION`: Región (e.g. `us-east-2`).
- `S3_BUCKET_NAME`: Nombre del bucket S3 que contiene el modelo y los audios de prueba.
- `AWS_ACCOUNT_ID`: ID de tu cuenta AWS para armar la URL del ECR.
- `EC2_SSH_PRIVATE_KEY`: Llave privada SSH para conectarse a tu EC2.
- `EC2_HOST`: IP pública de tu instancia EC2.

*Nota: Asegúrate de crear un repositorio privado en Amazon ECR llamado `whisper-onnx-api`.*

## Logs y Predicciones

Para facilitar futuros monitoreos y análisis, cada predicción realizada es guardada directamente de regreso en el bucket S3 como una nueva línea en un archivo de texto llamado `predicciones_dev.txt` o `predicciones_prod.txt` dependiendo del entorno.

## Ejecución Local

Para probar la aplicación en tu computadora:

1. Clona el repositorio.
2. Copia `.env.example` a `.env` y rellena con tus credenciales de AWS.
3. Instala dependencias (`apt install libsndfile1 ffmpeg` en Ubuntu/WSL) y corre:
   ```bash
   pip install fastapi uvicorn python-multipart boto3 transformers optimum[onnxruntime] librosa soundfile python-dotenv
   ```
4. Ejecuta el servidor:
   ```bash
   uvicorn app:app --reload
   ```

## Posibles Mejoras

- **Concurrencia al escribir a S3**: En la versión actual, escribir en S3 (descargar, adjuntar texto y subir) puede sufrir de _race conditions_ (condiciones de carrera) en escenarios de mucha carga concurrente. Se recomienda utilizar SQS, una base de datos u otros mecanismos para los logs en el futuro.
