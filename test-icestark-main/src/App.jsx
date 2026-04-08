import React from 'react'
import { AppRouter, AppRoute } from '@ice/stark'

function App() {
  return (
    <div style={{ padding: '20px' }}>
      <h1>Icestark Main App</h1>
      <div style={{ marginBottom: '20px' }}>
        <a href="/opencode" style={{ marginRight: '10px' }}>OpenCode Micro App</a>
        <a href="/">Home</a>
      </div>
      
      <div 
        id="micro-app-container" 
        style={{ 
          border: '2px dashed #ccc', 
          minHeight: '400px',
          padding: '20px'
        }}
      >
        <AppRouter>
          <AppRoute
            name="opencode"
            activePath="/opencode"
            url={[
              "http://localhost:3000/assets/micro-app.css",
              "http://localhost:3000/index.js"
            ]}
            loadScriptMode="import"
          />
        </AppRouter>
      </div>
    </div>
  )
}

export default App
