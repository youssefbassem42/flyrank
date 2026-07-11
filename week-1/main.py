from fastapi import FastAPI, status


app = FastAPI()

@app.get('/health', status_code=status.HTTP_200_OK)
def health_check():
    return {"message": "hello world"}

@app.post('/hello/', status_code=status.HTTP_200_OK)
def hello_user(name: str):
    return {"message": f"hello {name}"}