import os
import time
from contextlib import asynccontextmanager
import boto3
from dotenv import load_dotenv
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.staticfiles import StaticFiles
from transformers import AutoProcessor, pipeline
from optimum.onnxruntime import ORTModelForSpeechSeq2Seq
import librosa

# Load .env file (no-op if the file doesn't exist, e.g. in Docker where env vars are injected)
load_dotenv()

# Environment variables
AWS_ACCESS_KEY_ID = os.getenv("AWS_ACCESS_KEY_ID")
AWS_SECRET_ACCESS_KEY = os.getenv("AWS_SECRET_ACCESS_KEY")
AWS_REGION = os.getenv("AWS_REGION")
S3_BUCKET_NAME = os.getenv("S3_BUCKET_NAME")
ENVIRONMENT = os.getenv("ENVIRONMENT", "dev")

MODEL_DIR = "/tmp/model/"
S3_MODEL_PREFIX = "whisper_onnx_model/"

model = None
processor = None
s3_client = None
asr_pipeline = None

def download_s3_folder(bucket_name, s3_folder, local_dir):
    """
    Downloads a folder from S3 to a local directory.
    """
    if not os.path.exists(local_dir):
        os.makedirs(local_dir)
    
    paginator = s3_client.get_paginator('list_objects_v2')
    for result in paginator.paginate(Bucket=bucket_name, Prefix=s3_folder):
        if 'Contents' in result:
            for key in result['Contents']:
                file_key = key['Key']
                if file_key.endswith('/'):
                    continue
                local_file_path = os.path.join(local_dir, os.path.relpath(file_key, s3_folder))
                os.makedirs(os.path.dirname(local_file_path), exist_ok=True)
                print(f"Downloading {file_key} to {local_file_path}")
                s3_client.download_file(bucket_name, file_key, local_file_path)

def _model_already_cached(model_dir):
    """
    Check if the essential model files already exist locally.
    Used to skip S3 downloads during local development.
    """
    required_files = [
        "config.json",
        "encoder_model.onnx",
        "decoder_model_merged_int8.onnx",
        "preprocessor_config.json",
        "tokenizer.json",
    ]
    return all(os.path.exists(os.path.join(model_dir, f)) for f in required_files)

@asynccontextmanager
async def lifespan(app: FastAPI):
    global model, processor, s3_client, asr_pipeline
    
    # Initialize S3 client
    s3_client = boto3.client(
        's3',
        aws_access_key_id=AWS_ACCESS_KEY_ID,
        aws_secret_access_key=AWS_SECRET_ACCESS_KEY,
        region_name=AWS_REGION
    )
    
    # ── Skip download if the model is already cached locally ──
    # Useful for local dev to avoid hitting S3 on every restart.
    # In Docker / CI the /tmp/model/ dir is always empty, so this is a no-op.
    if _model_already_cached(MODEL_DIR):
        print(f"Model already cached in {MODEL_DIR}, skipping S3 download.")
    else:
        print("Downloading model from S3...")
        download_s3_folder(S3_BUCKET_NAME, S3_MODEL_PREFIX, MODEL_DIR)
        print("Model downloaded successfully.")
    
    print("Loading model and processor...")
    processor = AutoProcessor.from_pretrained(MODEL_DIR)
    model = ORTModelForSpeechSeq2Seq.from_pretrained(
        MODEL_DIR,
        encoder_file_name="encoder_model.onnx",
        decoder_file_name="decoder_model_merged_int8.onnx",
        decoder_with_past_file_name="decoder_model_merged_int8.onnx",
        use_io_binding=False
    )
    
    asr_pipeline = pipeline(
        "automatic-speech-recognition",
        model=model,
        tokenizer=processor.tokenizer,
        feature_extractor=processor.feature_extractor,
        chunk_length_s=30,
        batch_size=1,
    )
    
    print("Model loaded successfully.")
    
    yield
    
    # Cleanup if necessary
    print("Shutting down...")

app = FastAPI(lifespan=lifespan)

@app.post("/predict")
async def predict(file: UploadFile = File(...)):
    if not file.filename.endswith((".wav", ".mp3")):
        raise HTTPException(status_code=400, detail="Only .wav or .mp3 files are supported")
    
    # Save uploaded file temporarily
    temp_audio_path = f"/tmp/{file.filename}"
    with open(temp_audio_path, "wb") as f:
        f.write(await file.read())
        
    try:
        # Load audio (Whisper expects 16000Hz)
        audio_data, sampling_rate = librosa.load(temp_audio_path, sr=16000)
        
        # Process audio using the pipeline which handles chunking automatically
        # for audios longer than 30 seconds.
        result = asr_pipeline(
            audio_data,
            generate_kwargs={"language": "es"}
        )
        transcription = result["text"].strip()
        
        # Save prediction to S3
        timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
        log_entry = f"[{timestamp}] File: {file.filename} | Transcription: {transcription}\n"
        
        dest_filename = f"predicciones_{ENVIRONMENT}.txt"
        
        # S3 append workaround (download, append, upload)
        # TODO: Mejorar atomicidad usando bloqueo o colas
        try:
            existing_obj = s3_client.get_object(Bucket=S3_BUCKET_NAME, Key=dest_filename)
            existing_content = existing_obj['Body'].read().decode('utf-8')
            new_content = existing_content + log_entry
        except s3_client.exceptions.NoSuchKey:
            new_content = log_entry
            
        s3_client.put_object(
            Bucket=S3_BUCKET_NAME,
            Key=dest_filename,
            Body=new_content.encode('utf-8')
        )
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if os.path.exists(temp_audio_path):
            os.remove(temp_audio_path)
            
    return {"filename": file.filename, "transcription": transcription}

app.mount("/", StaticFiles(directory="static", html=True), name="static")

