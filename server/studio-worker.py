"""Local frame operations. Invoked with a JSON job file by the export engine."""
import json
import math
import os
import sys
from pathlib import Path
import cv2
import numpy as np

cv2.setNumThreads(2)

def read(file):
    image = cv2.imdecode(np.fromfile(str(file), dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("Unreadable frame: " + str(file))
    return image

def write(file, image):
    ok, data = cv2.imencode('.png', image, [cv2.IMWRITE_PNG_COMPRESSION, 1])
    if not ok:
        raise ValueError('Could not encode frame')
    data.tofile(str(file))

def detector():
    return cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')

def faces(image, cascade):
    ratio = min(1, 640 / image.shape[1])
    small = cv2.resize(image, None, fx=ratio, fy=ratio)
    found = cascade.detectMultiScale(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY), 1.15, 5, minSize=(24, 24))
    return [tuple(int(v / ratio) for v in box) for box in found]

class OnnxModel:
    def __init__(self, file, config):
        import onnxruntime as ort
        ort.disable_telemetry_events()
        self.ort, self.file = ort, str(file)
        self.options = ort.SessionOptions()
        self.options.enable_mem_pattern = False
        self.options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        self.options.intra_op_num_threads = max(1, min(6, os.cpu_count() or 1))
        gpu = config.get('inferenceDevice') != 'cpu' and 'DmlExecutionProvider' in ort.get_available_providers()
        self.providers = ['DmlExecutionProvider', 'CPUExecutionProvider'] if gpu else ['CPUExecutionProvider']
        self.session = None

    def __call__(self, tensor):
        try:
            if self.session is None:
                self.session = self.ort.InferenceSession(self.file, self.options, providers=self.providers)
                print(json.dumps({'inference': Path(self.file).stem, 'providers': self.session.get_providers()}), flush=True)
            return self.session.run(None, {'image': tensor})[0]
        except Exception:
            if self.providers == ['CPUExecutionProvider']:
                raise
            # Driver/device failures get one explicit CPU retry, with the same weights.
            self.providers = ['CPUExecutionProvider']
            self.session = None
            print(json.dumps({'inference': Path(self.file).stem, 'fallback': 'CPU'}), flush=True)
            return self(tensor)

def onnx_models(config):
    root = Path(config['models'])
    face = OnnxModel(root / 'face.onnx', config) if config.get('face', 0) else None
    noise = OnnxModel(root / 'denoise.onnx', config) if config.get('denoise') == 'ai' else None
    def restore(image):
        tensor = np.ascontiguousarray(cv2.cvtColor(image, cv2.COLOR_BGR2RGB).transpose(2, 0, 1)[None], dtype=np.float32) / 127.5 - 1
        result = face(tensor)[0].transpose(1, 2, 0)
        return cv2.cvtColor(((np.clip(result, -1, 1)+1)*127.5).astype(np.uint8), cv2.COLOR_RGB2BGR)
    def denoise(image):
        h, w = image.shape[:2]
        output = np.empty_like(image)
        # 32 convolutions need a 33-pixel halo to avoid seams between tile cores.
        halo, core, size = 34, 188, 256
        for y in range(0, h, core):
            for x in range(0, w, core):
                x0, y0 = max(0, x-halo), max(0, y-halo)
                x1, y1 = min(w, x+core+halo), min(h, y+core+halo)
                tile = image[y0:y1, x0:x1]
                tile = cv2.copyMakeBorder(tile, 0, size-tile.shape[0], 0, size-tile.shape[1], cv2.BORDER_REFLECT_101)
                tensor = np.ascontiguousarray(cv2.cvtColor(tile, cv2.COLOR_BGR2RGB).transpose(2, 0, 1)[None], dtype=np.float32) / 255
                restored = noise(tensor)[0].transpose(1, 2, 0)
                restored = cv2.resize(restored, (size, size), interpolation=cv2.INTER_LANCZOS4)
                end_x, end_y = min(w, x+core), min(h, y+core)
                pixels = np.rint(np.clip(restored[y-y0:y-y0+end_y-y, x-x0:x-x0+end_x-x], 0, 1)*255).astype(np.uint8)
                output[y:end_y, x:end_x] = cv2.cvtColor(pixels, cv2.COLOR_RGB2BGR)
        return output
    return restore if face else None, denoise if noise else None

def neural_models(config):
    root = Path(config['models'])
    required = ([root / 'face.onnx'] if config.get('face', 0) else []) + ([root / 'denoise.onnx'] if config.get('denoise') == 'ai' else [])
    if all(file.exists() for file in required):
        return onnx_models(config)
    import torch
    import torchvision.transforms.functional as functional
    # BasicSR 1.4 targets the pre-0.17 torchvision module name.
    sys.modules['torchvision.transforms.functional_tensor'] = functional
    torch.set_num_threads(max(1, min(6, os.cpu_count() or 1)))
    face_model = denoiser = None
    root = Path(config['models'])
    if config.get('face', 0):
        from gfpgan.archs.gfpganv1_clean_arch import GFPGANv1Clean
        face_model = GFPGANv1Clean(out_size=512, num_style_feat=512, channel_multiplier=2,
            decoder_load_path=None, fix_decoder=False, num_mlp=8, input_is_latent=True,
            different_w=True, narrow=1, sft_half=True)
        weights = torch.load(root / 'GFPGANv1.4.pth', map_location='cpu', weights_only=True)
        face_model.load_state_dict(weights['params_ema'], strict=True)
        face_model.eval()
    if config.get('denoise') == 'ai':
        from realesrgan.archs.srvgg_arch import SRVGGNetCompact
        from realesrgan import RealESRGANer
        model = SRVGGNetCompact(num_in_ch=3, num_out_ch=3, num_feat=64, num_conv=32, upscale=4, act_type='prelu')
        denoiser = RealESRGANer(scale=4, model_path=str(root / 'realesr-general-x4v3.pth'),
            model=model, tile=128, tile_pad=10, pre_pad=0, half=False, device=torch.device('cpu'))
    def restore(image):
        tensor = torch.from_numpy(cv2.cvtColor(image, cv2.COLOR_BGR2RGB).transpose(2, 0, 1).copy()).float().div(127.5).sub(1).unsqueeze(0)
        with torch.inference_mode():
            pixels = face_model(tensor, return_rgb=False, randomize_noise=False)[0][0].clamp(-1, 1).add(1).mul(127.5).permute(1, 2, 0).numpy().astype(np.uint8)
        return cv2.cvtColor(pixels, cv2.COLOR_RGB2BGR)
    return restore if face_model else None, (lambda image: denoiser.enhance(image, outscale=1)[0]) if denoiser else None

def process(config):
    files = sorted(Path(config['input']).glob('*.png'))
    if not files:
        raise ValueError('No frames to process')
    dest = Path(config['output']); dest.mkdir(exist_ok=True)
    cascade = detector()
    neural = config.get('face', 0) or config.get('denoise') == 'ai'
    face_model, denoiser = neural_models(config) if neural else (None, None)
    center = None
    count_faces = 0
    for index, file in enumerate(files):
        original = read(file); image = original.copy()
        boxes = faces(original, cascade) if config.get('face', 0) or config.get('crop') == 'follow' else []
        if denoiser:
            clean = denoiser(image)
            image = cv2.addWeighted(image, .35, clean, .65, 0)
        if face_model:
            for x, y, w, h in boxes:
                pad = int(w * .15)
                x0, y0 = max(0, x-pad), max(0, y-pad)
                x1, y1 = min(image.shape[1], x+w+pad), min(image.shape[0], y+h+pad)
                roi = image[y0:y1, x0:x1]
                aligned = cv2.resize(roi, (512, 512))
                restored = cv2.resize(face_model(aligned), (x1-x0, y1-y0))
                mask = np.zeros(roi.shape[:2], np.float32)
                cv2.ellipse(mask, ((x1-x0)//2, (y1-y0)//2), (max(1,(x1-x0)//3), max(1,(y1-y0)*2//5)), 0, 0, 360, 1, -1)
                mask = cv2.GaussianBlur(mask, (0, 0), max(1, w*.08))[:, :, None] * config['face']
                image[y0:y1, x0:x1] = np.clip(roi*(1-mask)+restored*mask, 0, 255).astype(np.uint8)
                count_faces += 1
        if config.get('crop', 'off') != 'off':
            h, w = image.shape[:2]
            cw, ch = (int(h*9/16)//2*2, h//2*2) if w/h > 9/16 else (w//2*2, int(w*16/9)//2*2)
            target = .5
            if config['crop'] == 'follow' and boxes:
                x, y, fw, fh = max(boxes, key=lambda box: box[2]*box[3])
                target = (x+fw/2)/w
            elif config['crop'] == 'manual':
                target = config.get('cropX', .5)
            center = target if center is None else .85*center+.15*target
            left = max(0, min(w-cw, round(center*w-cw/2)))
            top = max(0, min(h-ch, round(config.get('cropY', .5)*(h-ch))))
            image = image[top:top+ch, left:left+cw]
        write(dest / file.name, image)
        print(json.dumps({'frame': index+1, 'faces': count_faces}), flush=True)
    print(json.dumps({'completed': len(files), 'faces': count_faces}), flush=True)

def protect(config):
    sources = sorted(Path(config['input']).glob('*.png'))
    outputs = sorted(Path(config['output']).glob('*.png'))
    cuts, fast = [], []
    previous = None
    for i, source in enumerate(sources):
        small = cv2.resize(read(source), (96, 54))
        if previous is not None:
            delta = float(np.mean(cv2.absdiff(small, previous)))/255
            if delta > .3: cuts.append(i)
            elif config.get('motionGuard') == 'conservative' and delta > .12: fast.append(i)
        previous = small
    ratio = config['fps']/config['sourceFps']
    for i in cuts+fast:
        for j in range(max(0, math.floor((i-1)*ratio)+1), min(len(outputs), math.ceil(i*ratio))):
            nearest = i if j/ratio >= i-.5 else i-1
            frame = read(sources[nearest]); existing = read(outputs[j])
            write(outputs[j], cv2.resize(frame, (existing.shape[1], existing.shape[0])))
    print(json.dumps({'sceneCuts': len(cuts), 'motionHolds': len(fast)}), flush=True)

if __name__ == '__main__':
    with open(sys.argv[1], encoding='utf-8') as stream:
        config = json.load(stream)
    if config.get('task') == 'protect': protect(config)
    else: process(config)
