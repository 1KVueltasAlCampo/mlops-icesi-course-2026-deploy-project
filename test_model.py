import os
import time
import pytest
import boto3
import librosa
import csv
from jiwer import wer
from transformers import AutoProcessor, pipeline
from optimum.onnxruntime import ORTModelForSpeechSeq2Seq

# Assuming the model is already downloaded to /tmp/model/ by the CI/CD setup
MODEL_DIR = "/tmp/model/"
TEST_AUDIO_S3_KEY = "test_data/sample.wav" # Ensure this exists in your S3 test setup

@pytest.fixture(scope="module")
def setup_model_and_audio():
    # Load environment variables
    bucket_name = os.getenv("S3_BUCKET_NAME")
    
    # Download test audio from S3
    s3 = boto3.client('s3')
    local_audio_path = "/tmp/sample.wav"
    
    # We try to download, if it fails because bucket/key doesn't exist yet we skip gracefully
    # or let the test fail if strictly enforced.
    s3.download_file(bucket_name, TEST_AUDIO_S3_KEY, local_audio_path)
    
    # Load model and processor
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
    
    # Load audio data
    audio_data, sr = librosa.load(local_audio_path, sr=16000)
    
    yield asr_pipeline, audio_data, sr
    
    # Cleanup
    if os.path.exists(local_audio_path):
        os.remove(local_audio_path)

@pytest.fixture(scope="module")
def setup_wer_data():
    bucket_name = os.getenv("S3_BUCKET_NAME")
    s3 = boto3.client('s3')
    
    local_dir = "/tmp/wer_data"
    os.makedirs(local_dir, exist_ok=True)
    
    csv_local_path = os.path.join(local_dir, "wer_reference.csv")
    s3.download_file(bucket_name, "test_data/wer_reference.csv", csv_local_path)
    
    data = []
    with open(csv_local_path, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            filename = row["filename"].strip()
            reference = row["reference"].strip()
            
            # Download audio file
            audio_s3_key = f"test_data/{filename}"
            audio_local_path = os.path.join(local_dir, filename)
            s3.download_file(bucket_name, audio_s3_key, audio_local_path)
            
            data.append({
                "audio_path": audio_local_path,
                "reference": reference
            })
            
    # Load model and processor for WER test
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
    
    yield asr_pipeline, data
    
    # Cleanup
    for item in data:
        if os.path.exists(item["audio_path"]):
            os.remove(item["audio_path"])
    if os.path.exists(csv_local_path):
        os.remove(csv_local_path)
    if os.path.exists(local_dir):
        os.rmdir(local_dir)

def test_model_inference_no_errors(setup_model_and_audio):
    asr_pipeline, audio_data, sr = setup_model_and_audio
    
    # Run inference, ensure no exception is raised
    try:
        result = asr_pipeline(audio_data, generate_kwargs={"language": "es"})
        transcription = result["text"].strip()
        assert isinstance(transcription, str)
        assert len(transcription) > 0
    except Exception as e:
        pytest.fail(f"Model inference failed with exception: {e}")

def test_model_latency(setup_model_and_audio):
    asr_pipeline, audio_data, sr = setup_model_and_audio
    
    start_time = time.time()
    _ = asr_pipeline(audio_data, generate_kwargs={"language": "es"})
    end_time = time.time()
    
    latency = end_time - start_time
    print(f"Inference latency: {latency:.2f} seconds")
    
    # Fail if latency exceeds 5 seconds
    assert latency <= 5.0, f"Latency {latency:.2f}s exceeded the 5.0s threshold"

def test_model_wer_metric(setup_wer_data):
    asr_pipeline, data = setup_wer_data
    
    total_wer = 0
    count = len(data)
    assert count >= 3, "El archivo wer_reference.csv debe tener al menos 3 audios de prueba."
    
    for item in data:
        audio_data, sr = librosa.load(item["audio_path"], sr=16000)
        result = asr_pipeline(audio_data, generate_kwargs={"language": "es"})
        transcription = result["text"].strip()
        
        error_rate = wer(item["reference"], transcription)
        total_wer += error_rate
        
    avg_wer = total_wer / count if count > 0 else 0
    print(f"Average WER: {avg_wer:.4f}")
    
    # Fail if avg WER > 0.5
    assert avg_wer <= 0.5, f"Average WER {avg_wer:.4f} exceeds the 0.5 threshold"
