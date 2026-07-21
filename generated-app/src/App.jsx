import React from 'react';
import './App.css';

const FeedbackForm = () => {
    return (
        <div className="container">
            <h1>Feedback Form</h1>
            <form>
                <label htmlFor="email">Email:</label>
                <input type="email" id="email" required />
                <div className="ratings">
                    <label>Rating:</label>
                    <label><input type="radio" name="rating" value="1" /> 1</label>
                    <label><input type="radio" name="rating" value="2" /> 2</label>
                    <label><input type="radio" name="rating" value="3" /> 3</label>
                    <label><input type="radio" name="rating" value="4" /> 4</label>
                    <label><input type="radio" name="rating" value="5" /> 5</label>
                </div>
                <label htmlFor="comments">Comments:</label>
                <textarea id="comments" rows="4" required></textarea>
                <button type="submit">Submit Feedback</button>
            </form>
        </div>
    );
};

export default FeedbackForm;