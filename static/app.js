document.addEventListener('DOMContentLoaded', () => {
    // URL de la API: como servimos el frontend desde FastAPI, el endpoint predict es relativo
    const API_URL = '/predict';

    // Elementos del DOM
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');
    const fileInfo = document.getElementById('file-info');
    const fileName = document.getElementById('file-name');
    const fileSize = document.getElementById('file-size');
    const btnRemoveFile = document.getElementById('btn-remove-file');
    
    const btnRecord = document.getElementById('btn-record');
    const btnStop = document.getElementById('btn-stop');
    const recordingIndicator = document.getElementById('recording-indicator');
    const recordingTime = document.getElementById('recording-time');

    const btnTranscribe = document.getElementById('btn-transcribe');
    const loadingArea = document.getElementById('loading-area');
    const resultBox = document.getElementById('result-box');
    const btnCopy = document.getElementById('btn-copy');
    const alertMessage = document.getElementById('alert-message');
    
    const historyList = document.getElementById('history-list');
    const emptyHistory = document.getElementById('empty-history');
    const btnClearHistory = document.getElementById('btn-clear-history');
    const themeToggle = document.getElementById('theme-toggle');

    // Estado interno
    let currentFile = null;
    let mediaRecorder = null;
    let audioChunks = [];
    let recordTimer = null;
    let secondsRecorded = 0;

    const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB

    // Inicialización
    initTheme();
    loadHistory();

    // --- Sonido de notificación Web Audio API ---
    const playSuccessSound = () => {
        try {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            const ctx = new AudioContext();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            
            // Un tono suave y profesional
            osc.type = 'sine';
            osc.frequency.setValueAtTime(523.25, ctx.currentTime); 
            osc.frequency.exponentialRampToValueAtTime(1046.50, ctx.currentTime + 0.1); 
            
            gain.gain.setValueAtTime(0, ctx.currentTime);
            gain.gain.linearRampToValueAtTime(0.1, ctx.currentTime + 0.05);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
            
            osc.start(ctx.currentTime);
            osc.stop(ctx.currentTime + 0.5);
        } catch(e) {
            console.log("Audio de notificación no soportado en este navegador.");
        }
    };

    // --- Lógica Drag and Drop ---
    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('dragover');
    });

    dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('dragover');
    });

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('dragover');
        if (e.dataTransfer.files.length) {
            handleFileSelection(e.dataTransfer.files[0]);
        }
    });

    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length) {
            handleFileSelection(e.target.files[0]);
        }
    });

    function handleFileSelection(file) {
        // Validación de tipo de archivo (API soporta wav y mp3)
        const validTypes = ['audio/wav', 'audio/mpeg', 'audio/mp3', 'audio/x-wav'];
        // Fallback por si file.type viene vacío en algunos OS
        const isValidExtension = file.name.match(/\.(wav|mp3)$/i);
        
        if (!validTypes.includes(file.type) && !isValidExtension) {
            showAlert('Por favor sube un archivo de formato .wav o .mp3 válido para el expediente.', 'danger');
            return;
        }

        if (file.size > MAX_FILE_SIZE) {
            showAlert('El archivo supera el límite permitido de 25 MB.', 'danger');
            return;
        }

        currentFile = file;
        
        // Actualizar UI
        fileName.textContent = file.name;
        fileSize.textContent = (file.size / (1024 * 1024)).toFixed(2) + ' MB';
        
        dropZone.classList.add('d-none');
        fileInfo.classList.remove('d-none');
        btnTranscribe.disabled = false;
        hideAlert();
        
        // Reset zona de resultado
        resultBox.innerHTML = 'Evidencia lista para ser transcrita.';
        resultBox.classList.remove('text-dark', 'text-light', 'fw-normal', 'text-start', 'd-block');
        resultBox.classList.add('text-muted', 'd-flex', 'align-items-center', 'justify-content-center', 'text-center');
        btnCopy.classList.add('d-none');
    }

    btnRemoveFile.addEventListener('click', resetFileState);

    function resetFileState() {
        currentFile = null;
        fileInput.value = '';
        dropZone.classList.remove('d-none');
        fileInfo.classList.add('d-none');
        btnTranscribe.disabled = true;
    }

    // --- Lógica de Grabación en Vivo ---
    btnRecord.addEventListener('click', async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaRecorder = new MediaRecorder(stream);
            
            mediaRecorder.ondataavailable = e => {
                if (e.data.size > 0) audioChunks.push(e.data);
            };

            mediaRecorder.onstop = () => {
                // Navegadores graban usualmente en WebM o OGG. Para este prototipo enviamos el Blob forzado a wav.
                // En un entorno de producción absoluto el backend usaría FFmpeg para convertir cualquier formato.
                // El modelo Whisper y librosa en nuestro backend ya maneja la decodificación interna mediante ffmpeg.
                const audioBlob = new Blob(audioChunks, { type: 'audio/wav' });
                const file = new File([audioBlob], `Declaracion_${new Date().toISOString().replace(/[:.]/g,'-')}.wav`, { type: 'audio/wav' });
                audioChunks = [];
                handleFileSelection(file);
                
                // Detener hardware
                stream.getTracks().forEach(track => track.stop());
            };

            audioChunks = [];
            mediaRecorder.start();
            
            // Actualizar UI
            btnRecord.classList.add('d-none');
            recordingIndicator.classList.remove('d-none');
            secondsRecorded = 0;
            updateRecordTimer();
            recordTimer = setInterval(updateRecordTimer, 1000);
            
            resetFileState(); // Quitar archivo anterior si lo había
        } catch (err) {
            showAlert('Permiso de micrófono denegado o hardware no encontrado.', 'warning');
        }
    });

    btnStop.addEventListener('click', () => {
        if(mediaRecorder && mediaRecorder.state !== 'inactive') {
            mediaRecorder.stop();
            clearInterval(recordTimer);
            
            recordingIndicator.classList.add('d-none');
            btnRecord.classList.remove('d-none');
        }
    });

    function updateRecordTimer() {
        secondsRecorded++;
        const m = Math.floor(secondsRecorded / 60).toString().padStart(2, '0');
        const s = (secondsRecorded % 60).toString().padStart(2, '0');
        recordingTime.textContent = `${m}:${s}`;
    }

    // --- Petición a la API (Transcribir) ---
    btnTranscribe.addEventListener('click', async () => {
        if (!currentFile) return;

        // UI en estado de carga
        btnTranscribe.classList.add('d-none');
        loadingArea.classList.remove('d-none');
        resultBox.innerHTML = '';
        btnCopy.classList.add('d-none');
        hideAlert();

        const formData = new FormData();
        formData.append('file', currentFile);

        try {
            const response = await fetch(API_URL, {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                let errorMsg = `Error del servidor (${response.status})`;
                try {
                    const errorData = await response.json();
                    if(errorData.detail) errorMsg = errorData.detail;
                } catch(e) {}
                throw new Error(errorMsg);
            }

            const data = await response.json();
            
            // Éxito
            playSuccessSound();
            showResult(data.transcription);
            saveToHistory(data.filename, data.transcription);

        } catch (error) {
            showAlert(error.message, 'danger');
            resultBox.innerHTML = 'Ocurrió un error al procesar la evidencia de audio.';
            resultBox.classList.add('d-flex', 'align-items-center', 'justify-content-center', 'text-center');
            resultBox.classList.remove('text-start', 'd-block');
        } finally {
            btnTranscribe.classList.remove('d-none');
            loadingArea.classList.add('d-none');
            resetFileState(); // Preparado para el siguiente archivo
        }
    });

    function showResult(text) {
        resultBox.classList.remove('text-muted', 'd-flex', 'align-items-center', 'justify-content-center', 'text-center');
        const isDark = document.documentElement.getAttribute('data-bs-theme') === 'dark';
        resultBox.classList.add(isDark ? 'text-light' : 'text-dark', 'fw-normal', 'text-start', 'fade-in', 'd-block');
        
        // Formato básico para legibilidad (párrafos si es largo, aunque Whisper lo entrega de corrido)
        resultBox.textContent = text || "[El audio procesado no contenía voz inteligible o era ruido]";
        btnCopy.classList.remove('d-none');
    }

    // --- Copiar al Portapapeles ---
    btnCopy.addEventListener('click', () => {
        const text = resultBox.textContent;
        navigator.clipboard.writeText(text).then(() => {
            const originalHtml = btnCopy.innerHTML;
            btnCopy.innerHTML = '<i class="bi bi-check2"></i> Copiado';
            btnCopy.classList.replace('btn-outline-secondary', 'btn-success');
            setTimeout(() => {
                btnCopy.innerHTML = originalHtml;
                btnCopy.classList.replace('btn-success', 'btn-outline-secondary');
            }, 2000);
        });
    });

    // --- Utilidades de Alertas ---
    function showAlert(msg, type) {
        alertMessage.textContent = msg;
        alertMessage.className = `alert alert-${type} mt-3 mb-0 fade-in`;
    }

    function hideAlert() {
        alertMessage.classList.add('d-none');
    }

    // --- Historial Local (LocalStorage) ---
    function saveToHistory(filename, transcription) {
        let history = JSON.parse(localStorage.getItem('lexscribe_history') || '[]');
        const entry = {
            id: Date.now(),
            date: new Date().toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' }),
            filename: filename,
            text: transcription
        };
        history.unshift(entry); // Agregar arriba
        if(history.length > 8) history.pop(); // Mantener solo las últimas 8 por limpieza
        localStorage.setItem('lexscribe_history', JSON.stringify(history));
        renderHistory();
    }

    function loadHistory() {
        renderHistory();
    }

    function renderHistory() {
        const history = JSON.parse(localStorage.getItem('lexscribe_history') || '[]');
        
        if (history.length === 0) {
            historyList.innerHTML = '';
            historyList.appendChild(emptyHistory);
            emptyHistory.classList.remove('d-none');
            return;
        }

        historyList.innerHTML = '';
        history.forEach(item => {
            const li = document.createElement('li');
            li.className = 'list-group-item py-3 fade-in';
            li.innerHTML = `
                <div class="d-flex justify-content-between align-items-center mb-2">
                    <strong class="text-primary"><i class="bi bi-file-earmark-text me-2"></i>${item.filename}</strong>
                    <span class="badge bg-secondary rounded-pill">${item.date}</span>
                </div>
                <div class="history-text mb-3 border p-2 rounded" style="font-size: 0.9rem;">${item.text}</div>
                <button class="btn btn-sm btn-outline-primary btn-restore" data-text="${encodeURIComponent(item.text)}">
                    <i class="bi bi-eye me-1"></i>Revisar Expediente Completo
                </button>
            `;
            historyList.appendChild(li);
        });

        // Eventos a los botones de restaurar
        document.querySelectorAll('.btn-restore').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const text = decodeURIComponent(e.currentTarget.getAttribute('data-text'));
                showResult(text);
                window.scrollTo({ top: 0, behavior: 'smooth' });
            });
        });
    }

    btnClearHistory.addEventListener('click', () => {
        if(confirm('¿Seguro que deseas limpiar el historial local de esta máquina?')) {
            localStorage.removeItem('lexscribe_history');
            renderHistory();
        }
    });

    // --- Alternar Tema Oscuro/Claro ---
    function initTheme() {
        const savedTheme = localStorage.getItem('theme') || 
            (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
        document.documentElement.setAttribute('data-bs-theme', savedTheme);
        updateThemeIcon(savedTheme);
    }

    themeToggle.addEventListener('click', () => {
        const currentTheme = document.documentElement.getAttribute('data-bs-theme');
        const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-bs-theme', newTheme);
        localStorage.setItem('theme', newTheme);
        updateThemeIcon(newTheme);
        
        // Actualizar dinámicamente el contraste del texto de la transcripción si ya se ha cargado
        if (!resultBox.classList.contains('text-muted')) {
            if (newTheme === 'dark') {
                resultBox.classList.replace('text-dark', 'text-light');
            } else {
                resultBox.classList.replace('text-light', 'text-dark');
            }
        }
    });

    function updateThemeIcon(theme) {
        if(theme === 'dark') {
            themeToggle.innerHTML = '<i class="bi bi-sun text-warning"></i> Modo Claro';
        } else {
            themeToggle.innerHTML = '<i class="bi bi-moon-stars"></i> Modo Oscuro';
        }
    }
});
