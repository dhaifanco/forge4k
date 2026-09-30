import json
import sys
import time
from pathlib import Path
import cv2
import numpy as np
import onnxruntime as ort
import torch
import torchvision.transforms.functional as functional
sys.modules['torchvision.transforms.functional_tensor'] = functional
from gfpgan.archs.gfpganv1_clean_arch import GFPGANv1Clean
from realesrgan.archs.srvgg_arch import SRVGGNetCompact

root = Path(__file__).resolve().parents[1]
models = root / 'bin/ai/models'
torch.set_num_threads(6)
image = cv2.imread(str(root / '.test-data/studio-neural/source/00000001.png'))
if image is None:
    from skimage.data import astronaut
    image = cv2.cvtColor(astronaut(), cv2.COLOR_RGB2BGR)
report = {}
for name, size in [('face', 512), ('denoise', 256)]:
    data = cv2.cvtColor(cv2.resize(image, (size, size)), cv2.COLOR_BGR2RGB).transpose(2, 0, 1)[None].astype(np.float32)
    data = np.ascontiguousarray(data / 127.5 - 1 if name == 'face' else data / 255)
    if name == 'face':
        model = GFPGANv1Clean(out_size=512, num_style_feat=512, channel_multiplier=2,
            decoder_load_path=None, fix_decoder=False, num_mlp=8, input_is_latent=True,
            different_w=True, narrow=1, sft_half=True)
        model.load_state_dict(torch.load(models / 'GFPGANv1.4.pth', map_location='cpu', weights_only=True)['params_ema'])
    else:
        model = SRVGGNetCompact(num_in_ch=3, num_out_ch=3, num_feat=64, num_conv=32, upscale=4, act_type='prelu')
        model.load_state_dict(torch.load(models / 'realesr-general-x4v3.pth', map_location='cpu', weights_only=True)['params'])
    model.eval()
    start = time.perf_counter()
    with torch.inference_mode():
        reference = model(torch.from_numpy(data), return_rgb=False, randomize_noise=False)[0].numpy() if name == 'face' else model(torch.from_numpy(data)).numpy()
    cpu_time = time.perf_counter() - start
    del model
    opts = ort.SessionOptions()
    opts.enable_mem_pattern = False
    opts.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    opts.intra_op_num_threads = 6
    opts.enable_profiling = True
    opts.profile_file_prefix = str(root / '.test-data' / ('ort-' + name))
    start = time.perf_counter()
    session = ort.InferenceSession(str(models / (name + '.onnx')), opts, providers=['DmlExecutionProvider', 'CPUExecutionProvider'])
    setup = time.perf_counter() - start
    times = []
    for _ in range(3):
        start = time.perf_counter()
        actual = session.run(None, {'image': data})[0]
        times.append(time.perf_counter() - start)
    profile = json.loads(Path(session.end_profiling()).read_text())
    providers = {}
    for item in profile:
        provider = item.get('args', {}).get('provider')
        if provider:
            providers[provider] = providers.get(provider, 0) + item.get('dur', 0)
    error = float(np.abs(reference - actual).max())
    report[name] = {'torchCpuSec': cpu_time, 'gpuSetupSec': setup, 'gpuRunsSec': times,
        'maxTensorError': error, 'meanTensorError': float(np.abs(reference-actual).mean()), 'providerTimeMicrosec': providers}
    print(json.dumps({name: report[name]}), flush=True)
    assert error < .015, 'GPU output differs excessively from the original model'
    assert providers.get('DmlExecutionProvider', 0) > 0, 'No profiled GPU execution'
    del session
    cpu_opts = ort.SessionOptions()
    cpu_opts.intra_op_num_threads = 6
    cpu_session = ort.InferenceSession(str(models / (name+'.onnx')), cpu_opts, providers=['CPUExecutionProvider'])
    start = time.perf_counter()
    cpu_output = cpu_session.run(None, {'image': data})[0]
    report[name]['onnxCpuSec'] = time.perf_counter()-start
    assert float(np.abs(reference-cpu_output).max()) < .015
    del cpu_session

import importlib.util
spec = importlib.util.spec_from_file_location('studio_worker', root / 'server/studio-worker.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
sample = cv2.resize(image, (430, 378))
_, denoise = worker.onnx_models({'models':str(models), 'denoise':'ai'})
start = time.perf_counter()
tiled = denoise(sample)
tile_time = time.perf_counter()-start
model = SRVGGNetCompact(num_in_ch=3, num_out_ch=3, num_feat=64, num_conv=32, upscale=4, act_type='prelu')
model.load_state_dict(torch.load(models / 'realesr-general-x4v3.pth', map_location='cpu', weights_only=True)['params'])
model.eval()
tensor = np.ascontiguousarray(cv2.cvtColor(sample,cv2.COLOR_BGR2RGB).transpose(2,0,1)[None],dtype=np.float32)/255
with torch.inference_mode():
    full = model(torch.from_numpy(tensor)).numpy()[0].transpose(1,2,0)
full = cv2.resize(full,(430,378),interpolation=cv2.INTER_LANCZOS4)
full = cv2.cvtColor(np.rint(np.clip(full,0,1)*255).astype(np.uint8),cv2.COLOR_RGB2BGR)
error = np.abs(tiled[36:-36,36:-36].astype(np.int16)-full[36:-36,36:-36].astype(np.int16))
report['tiles'] = {'resolution':'430x378', 'gpuSec':tile_time,'interiorMaxPixelError':int(error.max()),'interiorMeanPixelError':float(error.mean())}
assert error.max() <= 2 and error.mean() < .05, 'Tile seams differ from uninterrupted inference'
(root / '.test-data/studio-gpu-benchmark.json').write_text(json.dumps(report, indent=2))
